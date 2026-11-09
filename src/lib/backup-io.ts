import { BACKUP_JSON, buildBackup, imagePath, parseBackup, planImport, typeForImagePath, type ImportPlan } from './backup';
import { dataUrlToBlob, getImage, prepareImage, type StoredImage } from './images';
import { applyImport, getAllRecords, getHomeSettings, listFolders } from './storage';
import type { BackupImage } from './types';
import { createZip, looksLikeZip, readZip, readZipEntry, type ZipEntry, type ZipInput } from './zip';

/**
 * Export everything to a .zip: backup.json (records, folders, settings; images listed by
 * path) plus each image's original file under images/. Returns the number of records.
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
  const json = JSON.stringify(buildBackup(records, folders, images, home), null, 1);
  const zip = await createZip([{ name: BACKUP_JSON, data: new Blob([json], { type: 'application/json' }) }, ...files]);
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

/**
 * Validate, merge and apply a backup: a .zip from exportToFile, or a .json from older
 * builds (images as data URLs). All database writes happen in one transaction.
 */
export async function importFromFile(file: File): Promise<ImportPlan> {
  let entries: Map<string, ZipEntry> | undefined;
  let text: string;
  if (await looksLikeZip(file)) {
    entries = await readZip(file);
    const json = entries.get(BACKUP_JSON);
    if (!json) throw new Error(`Not a Read Tracker backup (no ${BACKUP_JSON} in the ZIP).`);
    text = await (await readZipEntry(file, json)).text();
  } else {
    text = await file.text();
  }
  const backup = parseBackup(text);
  // An image whose file is missing from the archive is treated like one the file doesn't carry.
  backup.images = backup.images.filter((img) => img.file === undefined || entries?.has(img.file));

  const [records, folders, home] = await Promise.all([getAllRecords(), listFolders(), getHomeSettings()]);
  const plan = planImport(records, folders, backup, home);
  // Read files and build previews first: async work is not allowed inside an IndexedDB transaction.
  const images: StoredImage[] = [];
  for (const img of plan.putImages) {
    const blob =
      img.file !== undefined
        ? await readZipEntry(file, entries!.get(img.file)!, typeForImagePath(img.file))
        : await dataUrlToBlob(img.dataUrl);
    const prepared = await prepareImage(blob);
    images.push({ ...prepared, id: img.id, recordId: img.recordId, addedAt: Date.now() });
  }
  await applyImport(plan.writeFolders, plan.write, images, plan.deleteImages, plan.writeHome);
  return plan;
}
