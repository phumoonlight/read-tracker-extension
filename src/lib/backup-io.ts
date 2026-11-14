import {
  boardBackupEntries,
  boardBackupPath,
  BACKUP_MANIFEST,
  BACKUP_RECORDS,
  buildManifest,
  imageIndex,
  imagePath,
  imageStem,
  imagesFromZip,
  parseManifest,
  parseRecordLine,
  planImport,
  recordLine,
  typeForImagePath,
  type BackupCounts,
} from './backup';
import { getBoardReads, importBoardReads } from './board-store';
import {
  boardOfIdsFile,
  boardPostCount,
  BOARDS,
  decodeBoardIds,
  encodeBoardIds,
  isEmptyBoardReads,
  mergeBoardReads,
  parseBoardFile,
  type BoardReads,
} from './boards';
import { getImage, prepareImage, type StoredImage } from './images';
import { readLines } from './lines';
import { applyImport, getAllRecords, getHomeSettings, listFolders } from './storage';
import type { BackupFile, ReadingRecord } from './types';
import { createZip, looksLikeZip, readZip, readZipEntry, type ZipEntry, type ZipInput } from './zip';

/**
 * Export everything to a .zip (layout 4):
 *   manifest.json   format, versions, export time, counts, folders, Home settings
 *   records.jsonl   one record per line
 *   images/<id>.ext original image files (found by id on import: no separate list)
 *   booru/<board>.bin    read posts of one board (binary, encodeBoardIds); boards with none have no file
 * Returns the number of records.
 */
export async function exportToFile(): Promise<number> {
  const [records, folders, home, boards] = await Promise.all([
    getAllRecords(),
    listFolders(),
    getHomeSettings(),
    getBoardReads(),
  ]);
  const files: ZipInput[] = [];
  const stems = new Set<string>();
  for (const r of records) {
    for (const id of r.images) {
      const img = await getImage(id);
      // One file per id (stems are unique for real ids: cuid2s, or UUIDs from before).
      if (!img || stems.has(imageStem(id))) continue;
      stems.add(imageStem(id));
      files.push({ name: imagePath(id, img.blob.type), data: img.blob });
    }
  }
  const booruPosts = boardPostCount(boards);
  const manifest = buildManifest(
    { records: records.length, images: files.length, ...(booruPosts ? { booruPosts } : {}) },
    folders,
    home,
  );
  const json = (v: unknown) => new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' });
  const boardsFile = BOARDS.filter((b) => boards.sites[b.key]?.length).map((b) => ({
    name: boardBackupPath(b.key),
    data: new Blob([encodeBoardIds(boards.sites[b.key]!)], { type: 'application/octet-stream' }),
  }));
  // One Blob part per line: no single giant string.
  const recordsFile = new Blob(records.map(recordLine), { type: 'application/x-ndjson' });
  const zip = await createZip([
    { name: BACKUP_MANIFEST, data: json(manifest) },
    { name: BACKUP_RECORDS, data: recordsFile },
    ...boardsFile,
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
  /** Board posts newly marked read (from the booru/ files). */
  booruPosts: number;
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
 * Open a backup .zip and read only what's needed to preview it (manifest.json). Throws a
 * user-facing error if it isn't a backup this build can read.
 */
export async function openBackup(file: File): Promise<OpenedBackup> {
  if (!(await looksLikeZip(file))) throw new Error('Not a Read Tracker backup (expected a .zip file).');
  const entries = await readZip(file);
  const manifestEntry = entries.get(BACKUP_MANIFEST);
  if (!manifestEntry) throw new Error(`Not a Read Tracker backup (no ${BACKUP_MANIFEST} in the ZIP).`);
  /** Problems found while opening (e.g. invalid folder domains); each run starts from a copy. */
  const openIssues: string[] = [];
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
      if (records.length !== manifest.counts.records) {
        issues.push(
          `${BACKUP_MANIFEST} lists ${manifest.counts.records} records but ${BACKUP_RECORDS} has ${records.length}.`,
        );
      }
      // Board history is small and parsed up front: a bad board file stops the import too.
      const boardFiles: BoardReads[] = [];
      for (const { name, binary } of boardBackupEntries(entries.keys())) {
        try {
          const blob = await readZipEntry(file, entries.get(name)!);
          if (!binary) boardFiles.push(parseBoardFile(await blob.text(), issues));
          else {
            const board = boardOfIdsFile(name);
            if (board) boardFiles.push({ sites: { [board]: decodeBoardIds(new Uint8Array(await blob.arrayBuffer())) } });
            else issues.push(`${name}: board isn't supported; its read posts were skipped.`);
          }
        } catch (e) {
          throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const boards = boardFiles.length ? mergeBoardReads(boardFiles) : undefined;
      const backup: BackupFile = {
        format: manifest.format,
        version: manifest.version,
        exportedAt: manifest.exportedAt,
        records,
        folders: manifest.folders,
        images: [],
        ...(manifest.home ? { home: manifest.home } : {}),
      };
      return mergeBackup(file, entries, backup, issues, boards);
    },
  };
}

/** Merge a parsed backup into the stored data. All database writes happen in one transaction. */
async function mergeBackup(
  file: File,
  entries: Map<string, ZipEntry>,
  backup: BackupFile,
  issues: string[],
  boards?: BoardReads,
): Promise<ImportResult> {
  // Each record's images are found by id among the ZIP's files; an id without
  // a file is reported by planImport on its record.
  backup.images = imagesFromZip(backup.records, imageIndex(entries.keys()));

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
  const booruPosts = boards && !isEmptyBoardReads(boards) ? await importBoardReads(boards) : 0;
  return { added: plan.added, updated: plan.updated, skipped: plan.skipped, booruPosts, issues };
}
