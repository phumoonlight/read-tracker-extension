import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** How long the button must be held. */
export const HOLD_MS = 1000;
const MESSAGE_MS = 1400;

type Phase = 'idle' | 'holding' | 'hint' | 'done';

/**
 * A button that only acts after being held for HOLD_MS (mouse, touch, or Space / Enter),
 * so a stray click can't trigger it. A fill shows progress; letting go early (or moving
 * off the button) cancels and briefly shows "Hold to update".
 */
export function HoldButton({
  children,
  onConfirm,
  className = '',
  title,
  doneLabel = 'Updated ✓',
  hintLabel = 'Hold to update',
  holdMs = HOLD_MS,
  disabled = false,
}: {
  children: ReactNode;
  onConfirm: () => void | Promise<unknown>;
  className?: string;
  title?: string;
  doneLabel?: string;
  hintLabel?: string;
  /** Hold time for this button (default HOLD_MS); longer for more destructive actions. */
  holdMs?: number;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const messageTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(holdTimer.current);
      clearTimeout(messageTimer.current);
    },
    [],
  );

  const showFor = (p: Phase) => {
    setPhase(p);
    clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setPhase('idle'), MESSAGE_MS);
  };

  function start() {
    if (phase === 'holding' || disabled) return;
    clearTimeout(messageTimer.current);
    setPhase('holding');
    holdTimer.current = setTimeout(() => {
      holdTimer.current = undefined;
      showFor('done');
      void onConfirm();
    }, holdMs);
  }

  /** Released or left before the hold completed: cancel without acting. */
  function cancel() {
    if (holdTimer.current === undefined) return;
    clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    showFor('hint');
  }

  const isKey = (e: KeyboardEvent) => e.key === ' ' || e.key === 'Enter';

  return (
    <button
      type="button"
      className={`hold-button ${phase === 'holding' ? 'is-holding' : ''} ${className}`}
      style={{ ['--hold-ms' as string]: `${holdMs}ms` }}
      title={title}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      // Long-press on touch screens would otherwise open the context menu.
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isKey(e)) return;
        e.preventDefault();
        if (!e.repeat) start();
      }}
      onKeyUp={(e) => {
        if (isKey(e)) cancel();
      }}
      onBlur={cancel}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label" aria-live="polite">
        {phase === 'done' ? doneLabel : phase === 'hint' ? hintLabel : children}
      </span>
    </button>
  );
}
