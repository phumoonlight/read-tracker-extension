/**
 * Checkbox selection of list rows (pure). A plain click toggles one row; a shift-click sets
 * every row from the anchor (the last row clicked) to the clicked one, both included, to the
 * clicked row's new state. The clicked row becomes the new anchor.
 */
export interface Selection {
  selected: ReadonlySet<string>;
  /** The row last clicked, the start of the next shift-click range. */
  anchor?: string;
}

export function clickSelect(order: readonly string[], sel: Selection, id: string, shift: boolean): Selection {
  const on = !sel.selected.has(id);
  const next = new Set(sel.selected);
  const from = shift && sel.anchor !== undefined ? order.indexOf(sel.anchor) : -1;
  const to = order.indexOf(id);
  // No usable anchor (none yet, or it left the list): a plain toggle.
  const range = from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const r of range) {
    if (on) next.add(r);
    else next.delete(r);
  }
  return { selected: next, anchor: id };
}
