import { buildBackup, parseBackup, planImport, type ImportPlan } from './backup';
import { deleteThumbnail, getThumbnail, putThumbnail, blobToDataUrl, dataUrlToBlob } from './thumbnails';
import { getAllRecords, putRecords } from './storage';

/** Collect everything into a backup file and trigger a download. */
export async function exportToFile(): Promise<number> {
  const records = await getAllRecords();
  const thumbnails: Record<string, string> = {};
  for (const r of records) {
    if (!r.hasThumbnail) continue;
    const blob = await getThumbnail(r.id);
    if (blob) thumbnails[r.id] = await blobToDataUrl(blob);
  }
  const backup = buildBackup(records, thumbnails);
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `read-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return records.length;
}

/** Validate, merge and apply a backup file. Thumbnails are written before records so cards never point at a missing image. */
export async function importFromFile(file: File): Promise<ImportPlan> {
  const backup = parseBackup(await file.text());
  const plan = planImport(await getAllRecords(), backup);
  for (const [id, dataUrl] of Object.entries(plan.putThumbnails)) {
    await putThumbnail(id, await dataUrlToBlob(dataUrl));
  }
  for (const id of plan.deleteThumbnails) await deleteThumbnail(id);
  await putRecords(plan.write);
  return plan;
}
