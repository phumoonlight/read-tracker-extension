import {
  BACKUP_IMAGES,
  BACKUP_JSON,
  BACKUP_MANIFEST,
  BACKUP_RECORDS,
  buildManifest,
  imagePath,
  parseBackup,
  parseImageLine,
  parseManifest,
  parseRecordLine,
  planImport,
  toJsonLine,
  typeForImagePath,
  type BackupCounts,
} from './backup';
import { getImage, prepareImage, type StoredImage } from './images';
import { readLines } from './lines';
import { applyImport, getAllRecords, getHomeSettings, listFolders } from './storage';
import type { BackupFile, BackupImage, ReadingRecord } from './types';
import { createZip, looksLikeZip, readZip, readZipEntry, type ZipEntry, type ZipInput } from './zip';

/**
 * Export everything to a .zip (layout 2):
 *   manifest.json   format, versions, export time, counts, folders, Home settings
 *   records.jsonl   one record per line
 *   images.jsonl    one { id, recordId, file } per line
 *   images/<id>.ext original image files
 * Returns the number of records.
 */
export async function exportToFile(): Promise<number> {
  const [records, folders, home] = await Promise.all([getAllRecords(), listFolders(), getHomeSettings()]);
  const images: BackupImage[] = [];
  const files: ZipInput[] = [];
  const used = new Set<string>();
  for (const r of records) {
    for (const id of r.images) {
      const img = await getImage(id);
      if (!img) continue;
      let path = imagePath(id, img.blob.type);
      // Ids made filename-safe could collide; keep paths unique.
      for (let n = 2; used.has(path); n++) path = imagePath(`${id}-${n}`, img.blob.type);
      used.add(path);
      images.push({ id, recordId: r.id, file: path });
      files.push({ name: path, data: img.blob });
    }
  }
  const manifest = buildManifest({ records: records.length, images: images.length }, folders, home);
  const json = (v: unknown) => new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' });
  // One Blob part per line: no single giant string.
  const jsonl = (items: unknown[]) => new Blob(items.map(toJsonLine), { type: 'application/x-ndjson' });
  const zip = await createZip([
    { name: BACKUP_MANIFEST, data: json(manifest) },
    { name: BACKUP_RECORDS, data: jsonl(records) },
    { name: BACKUP_IMAGES, data: jsonl(images) },
    ...files,
  ]);
  download(zip, `read-tracker-backup-${new Date().toISOString().slice(0, 10)}.zip`);
  return records.length;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  /** What was dropped or changed, for the user. Empty when everything came in as is. */
  issues: string[];
}

/** A backup that has been opened and checked, ready to preview and import. */
export interface OpenedBackup {
  exportedAt: number;
  counts: BackupCounts;
  /** Merge the backup into the stored data. */
  run(): Promise<ImportResult>;
}

/**
 * Open a backup .zip and read only what's needed to preview it (manifest.json; or, for
 * the first ZIP layout, the whole backup.json). Throws a user-facing error if it isn't
 * a backup this build can read.
 */
export async function openBackup(file: File): Promise<OpenedBackup> {
  if (!(await looksLikeZip(file))) throw new Error('Not a Read Tracker backup (expected a .zip file).');
  const entries = await readZip(file);
  const manifestEntry = entries.get(BACKUP_MANIFEST);
  /** Problems found while opening (e.g. invalid folder domains); each run starts from a copy. */
  const openIssues: string[] = [];

  if (manifestEntry) {
    const manifest = parseManifest(await (await readZipEntry(file, manifestEntry)).text(), openIssues);
    const recordsEntry = entries.get(BACKUP_RECORDS);
    if (!recordsEntry) throw new Error(`The backup has no ${BACKUP_RECORDS}.`);
    return {
      exportedAt: manifest.exportedAt,
      counts: manifest.counts,
      run: async () => {
        const issues = [...openIssues];
        // Streamed line by line; a bad record line stops the import before anything is written.
        const records: ReadingRecord[] = [];
        for await (const { line, lineNo } of readLines(await readZipEntry(file, recordsEntry))) {
          records.push(parseRecordLine(line, lineNo, manifest.version));
        }
        const images: BackupImage[] = [];
        const imagesEntry = entries.get(BACKUP_IMAGES);
        if (imagesEntry) {
          for await (const { line, lineNo } of readLines(await readZipEntry(file, imagesEntry))) {
            const img = parseImageLine(line, lineNo, issues);
            if (img) images.push(img);
          }
        }
        if (records.length !== manifest.counts.records) {
          issues.push(
            `${BACKUP_MANIFEST} lists ${manifest.counts.records} records but ${BACKUP_RECORDS} has ${records.length}.`,
          );
        }
        const backup: BackupFile = {
          format: manifest.format,
          version: manifest.version,
          exportedAt: manifest.exportedAt,
          records,
          folders: manifest.folders,
          images,
          ...(manifest.home ? { home: manifest.home } : {}),
        };
        return mergeBackup(file, entries, backup, issues);
      },
    };
  }

  // Layout 1 (the first ZIP backups): everything in backup.json.
  const jsonEntry = entries.get(BACKUP_JSON);
  if (!jsonEntry) throw new Error(`Not a Read Tracker backup (no ${BACKUP_MANIFEST} in the ZIP).`);
  const backup = parseBackup(await (await readZipEntry(file, jsonEntry)).text(), openIssues);
  return {
    exportedAt: backup.exportedAt,
    counts: { records: backup.records.length, folders: backup.folders.length, images: backup.images.length },
    run: () => mergeBackup(file, entries, { ...backup }, [...openIssues]),
  };
}

/** Merge a parsed backup into the stored data. All database writes happen in one transaction. */
async function mergeBackup(
  file: File,
  entries: Map<string, ZipEntry>,
  backup: BackupFile,
  issues: string[],
): Promise<ImportResult> {
  // An image whose file is missing from the archive is treated like one the file doesn't carry
  // (planImport then reports it on its record).
  backup.images = backup.images.filter((img) => entries.has(img.file));

  const [records, folders, home] = await Promise.all([getAllRecords(), listFolders(), getHomeSettings()]);
  const plan = planImport(records, folders, backup, home);
  issues.push(...plan.issues);

  // Read files and build previews first: async work is not allowed inside an IndexedDB transaction.
  // An image that can't be read is skipped (and taken off its record), not fatal.
  const images: StoredImage[] = [];
  const failed = new Set<string>();
  for (const img of plan.putImages) {
    try {
      const blob = await readZipEntry(file, entries.get(img.file)!, typeForImagePath(img.file));
      const prepared = await prepareImage(blob);
      images.push({ ...prepared, id: img.id, recordId: img.recordId, addedAt: Date.now() });
    } catch (e) {
      failed.add(img.id);
      issues.push(`${img.file}: ${e instanceof Error ? e.message : String(e)} Skipped.`);
    }
  }
  const write = failed.size
    ? plan.write.map((r) =>
        r.images.some((id) => failed.has(id)) ? { ...r, images: r.images.filter((id) => !failed.has(id)) } : r,
      )
    : plan.write;

  await applyImport(plan.writeFolders, write, images, plan.deleteImages, plan.writeHome);
  return { added: plan.added, updated: plan.updated, skipped: plan.skipped, issues };
}
