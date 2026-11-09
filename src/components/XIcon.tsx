/**
 * A drawn X for remove buttons. A "×" character sits low in most fonts, so it can't be
 * centred exactly; this can. Uses currentColor.
 */
export function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
