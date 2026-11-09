import { buildBackup, parseBackup, planImport, type ImportPlan } from './backup';
import { blobToDataUrl, dataUrlToBlob, getImage, prepareImage, type StoredImage } from './images';
import { applyImport, getAllRecords, listFolders } from './storage';
import type { BackupImage } from './types';

/** Collect everything (original images included) into a backup file and trigger a download. */
export async function exportToFile(): Promise<number> {
  const [records, folders] = await Promise.all([getAllRecords(), listFolders()]);
  const images: BackupImage[] = [];
  for (const r of records) {
    for (const id of r.images) {
      const img = await getImage(id);
      if (img) images.push({ id, recordId: r.id, dataUrl: await blobToDataUrl(img.blob) });
    }
  }
  const backup = buildBackup(records, folders, images);
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
  // Decode files and build previews first: async work is not allowed inside an IndexedDB transaction.
  const images: StoredImage[] = [];
  for (const img of plan.putImages) {
    const prepared = await prepareImage(await dataUrlToBlob(img.dataUrl));
    images.push({ ...prepared, id: img.id, recordId: img.recordId, addedAt: Date.now() });
  }
  await applyImport(plan.writeFolders, plan.write, images, plan.deleteImages);
  return plan;
}
