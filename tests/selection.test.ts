import { describe, expect, it } from 'vitest';
import { clickSelect, type Selection } from '@/lib/selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const sel = (ids: string[], anchor?: string): Selection => ({ selected: new Set(ids), anchor });
const ids = (s: Selection) => [...s.selected].sort();

describe('clickSelect', () => {
  it('toggles one row and makes it the anchor', () => {
    const s = clickSelect(order, sel([]), 'b', false);
    expect(ids(s)).toEqual(['b']);
    expect(s.anchor).toBe('b');
    expect(ids(clickSelect(order, s, 'b', false))).toEqual([]);
  });

  it('shift-click selects the range from the anchor, either direction', () => {
    expect(ids(clickSelect(order, sel(['b'], 'b'), 'd', true))).toEqual(['b', 'c', 'd']);
    expect(ids(clickSelect(order, sel(['d'], 'd'), 'a', true))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shift-click on a selected row clears the range', () => {
    const s = clickSelect(order, sel(['a', 'b', 'c', 'd'], 'a'), 'c', true);
    expect(ids(s)).toEqual(['d']);
    expect(s.anchor).toBe('c');
  });

  it('keeps selected rows outside the range', () => {
    expect(ids(clickSelect(order, sel(['a', 'e'], 'b'), 'c', true))).toEqual(['a', 'b', 'c', 'e']);
  });

  it('without an anchor in the list, shift-click toggles one row', () => {
    expect(ids(clickSelect(order, sel([]), 'c', true))).toEqual(['c']);
    expect(ids(clickSelect(order, sel(['x'], 'x'), 'c', true))).toEqual(['c', 'x']);
  });
});
