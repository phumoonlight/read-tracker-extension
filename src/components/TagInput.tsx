import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { addTagText, suggestTags } from '@/lib/tags';

/**
 * Tags as removable #chips. Type and press Enter or comma to add (pasting "a, b" adds
 * both); Backspace in an empty field removes the last chip; leaving the field adds what
 * was typed. While typing, existing tags are suggested (arrows + Enter/Tab, or click).
 */
export function TagInput({
  value,
  onChange,
  suggestions,
  label = 'Tags',
  chipPrefix = '#',
  addText = addTagText,
  placeholder = 'Add a tag…',
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing items with their usage counts (suggested while typing). */
  suggestions: readonly (readonly [string, number])[];
  label?: string;
  /** Shown before each chip ('#' for tags, '' for domains). */
  chipPrefix?: string;
  /** Turns typed / pasted text into the new list (normalizing, dropping invalid entries). */
  addText?: (current: readonly string[], text: string) => string[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const matches = open ? suggestTags(suggestions, draft, value) : [];

  const commit = (text: string) => {
    if (text.trim()) onChange(addText(value, text));
    setDraft('');
    setActive(0);
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) {
      e.preventDefault();
      commit(matches[active] ?? draft);
    } else if (e.key === 'Enter' && draft.trim()) {
      // Add the tag instead of submitting the form.
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Escape' && open && draft) {
      e.preventDefault();
      e.stopPropagation(); // close the suggestions, not the dialog
      setOpen(false);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="field">
      <span>{label}</span>
      <div className="tag-input" onClick={() => inputRef.current?.focus()}>
        {value.map((t) => (
          <span key={t} className="tag-input-chip">
            {chipPrefix}
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== t));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          aria-label={label}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            const text = e.target.value;
            setOpen(true);
            setActive(0);
            if (text.includes(',')) {
              // Everything before the last comma becomes tags; the rest keeps being typed.
              const cut = text.lastIndexOf(',');
              onChange(addText(value, text.slice(0, cut)));
              setDraft(text.slice(cut + 1));
            } else {
              setDraft(text);
            }
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            commit(draft);
          }}
        />
      </div>
      {matches.length > 0 && (
        <ul className="tag-suggestions" id={listId} role="listbox">
          {matches.map((t, i) => (
            <li
              key={t}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so the input keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(t);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {chipPrefix}
            {t}
              <span className="muted">{suggestions.find(([s]) => s === t)?.[1]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
