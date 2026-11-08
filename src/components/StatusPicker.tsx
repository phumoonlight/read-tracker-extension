import { STATUSES, STATUS_LABEL, type ReadStatus } from '@/lib/types';

export function StatusPicker({ value, onChange }: { value: ReadStatus; onChange: (s: ReadStatus) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Status">
      {STATUSES.map((s) => (
        <button key={s} type="button" data-status={s} aria-pressed={value === s} onClick={() => onChange(s)}>
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}
