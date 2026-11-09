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
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags with their usage counts. */
  suggestions: readonly (readonly [string, number])[];
  label?: string;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const matches = open ? suggestTags(suggestions, draft, value) : [];

  const commit = (text: string) => {
    if (text.trim()) onChange(addTagText(value, text));
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
            #{t}
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
          placeholder={value.length ? '' : 'Add a tag…'}
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
              onChange(addTagText(value, text.slice(0, cut)));
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
              #{t}
              <span className="muted">{suggestions.find(([s]) => s === t)?.[1]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
