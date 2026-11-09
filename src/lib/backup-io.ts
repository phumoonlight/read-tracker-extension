import { buildBackup, parseBackup, planImport, type ImportPlan } from './backup';
import { blobToDataUrl, dataUrlToBlob, getThumbnail } from './thumbnails';
import { applyImport, getAllRecords, listFolders } from './storage';

/** Collect everything into a backup file and trigger a download. */
export async function exportToFile(): Promise<number> {
  const [records, folders] = await Promise.all([getAllRecords(), listFolders()]);
  const thumbnails: Record<string, string> = {};
  for (const r of records) {
    if (!r.hasThumbnail) continue;
    const blob = await getThumbnail(r.id);
    if (blob) thumbnails[r.id] = await blobToDataUrl(blob);
  }
  const backup = buildBackup(records, folders, thumbnails);
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `read-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return records.length;
}

/** Validate, merge and apply a backup file. All writes happen in one transaction. */
export async function importFromFile(file: File): Promise<ImportPlan> {
  const backup = parseBackup(await file.text());
  const [records, folders] = await Promise.all([getAllRecords(), listFolders()]);
  const plan = planImport(records, folders, backup);
  // Decode blobs first: async work is not allowed inside an IndexedDB transaction.
  const blobs = new Map<string, Blob>();
  for (const [id, dataUrl] of Object.entries(plan.putThumbnails)) blobs.set(id, await dataUrlToBlob(dataUrl));
  await applyImport(plan.writeFolders, plan.write, blobs, plan.deleteThumbnails);
  return plan;
}
