import { STATUSES, STATUS_LABEL, type ReadStatus } from '@/lib/types';

export function StatusPicker({ value, onChange }: { value: ReadStatus; onChange: (s: ReadStatus) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Status">
      {STATUSES.map((s) => (
        <button key={s} type="button" data-status={s} aria-pressed={value === s} onClick={() => onChange(s)}>
          {/* The dot keeps the status colour; the selected button uses the primary colour. */}
          <span className="status-dot" aria-hidden="true" /> {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}
