/**
 * Pictures a marked link shows outside itself. The content scripts' CSS filters the link as a
 * whole (text, <img>s and background pictures inside it), so only one case is left here: a
 * link with nothing of its own to show (an empty overlay stretched over a card) dims the
 * background picture(s) it covers in the card around it. That card is the "scope": hovering it
 * counts as hovering the link (the picture may be a sibling of the link, so it isn't hovered
 * itself). Used by both content scripts; only the DOM-walking functions touch the page.
 */

/** At most this many pictures per link (a card with a sprite-heavy layout stays cheap). */
const MAX_PICTURES = 4;
/** Climb at most this many ancestors looking for the card an overlay link sits on. */
const MAX_UP = 4;
/** An ancestor this much bigger than the link is past the card (a grid or the page). */
const MAX_CARD_GROWTH = 2.5;
/** Links smaller than this (px²) are icons, not overlays. */
const MIN_OVERLAY_AREA = 400;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A computed `background-image` that draws a picture (not `none` or a plain gradient). */
export const hasUrlImage = (backgroundImage: string) => /url\(/i.test(backgroundImage);

/** The share (0..1) of `inner`'s area that `outer` covers. */
export function coveredShare(outer: Box, inner: Box): number {
  const area = inner.width * inner.height;
  if (area <= 0) return 0;
  const w = Math.min(outer.left + outer.width, inner.left + inner.width) - Math.max(outer.left, inner.left);
  const h = Math.min(outer.top + outer.height, inner.top + inner.height) - Math.max(outer.top, inner.top);
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

const drawsPicture = (el: Element) => hasUrlImage(getComputedStyle(el).backgroundImage);
const areaOf = (b: Box) => b.width * b.height;

export interface Pictures {
  pictures: Element[];
  /** The card around an overlay link (outside pictures only). */
  scope?: Element;
}

/** The link draws a picture itself: an <img>, or a `url(...)` background on it or inside it. */
export const drawsPictureInside = (a: Element) =>
  !!a.querySelector('img') || [a, ...a.querySelectorAll('*')].some(drawsPicture);

/**
 * The background pictures an overlay link covers, outside the link. None for a link that draws
 * a picture itself (filtering the link covers it) or shows text in the flow (not an overlay).
 */
export function picturesOf(a: Element): Pictures {
  if (drawsPictureInside(a)) return { pictures: [] };
  // An overlay: no text (or taken out of the flow to sit on top of the card).
  if (a.textContent?.trim() && getComputedStyle(a).position !== 'absolute') return { pictures: [] };
  const box = a.getBoundingClientRect();
  if (areaOf(box) < MIN_OVERLAY_AREA) return { pictures: [] };
  let card = a.parentElement;
  for (let up = 0; up < MAX_UP && card && card !== document.body; up++, card = card.parentElement) {
    if (areaOf(card.getBoundingClientRect()) > MAX_CARD_GROWTH * areaOf(box)) break;
    const found = [card, ...card.querySelectorAll('*')]
      .filter((el) => !a.contains(el) && drawsPicture(el) && coveredShare(box, el.getBoundingClientRect()) >= 0.5)
      .slice(0, MAX_PICTURES);
    if (found.length) return { pictures: found, scope: card };
  }
  return { pictures: [] };
}

/**
 * CSS selector for pictures tagged with `value`, while their link isn't hovered or focused:
 * not the picture itself, not inside a hovered / focused link, not inside a hovered card.
 */
export const pictureSelector = (pictureAttr: string, scopeAttr: string, value: string) =>
  `[${pictureAttr}="${value}"]:not(:hover,:focus-within,a:hover *,a:focus-visible *,` +
  `[${scopeAttr}]:hover *,[${scopeAttr}]:focus-within *)`;

/**
 * Keeps the picture tags on the page in step with the marked links: `apply` tags each link's
 * pictures with its mark and untags whatever no marked link shows any more.
 */
export function pictureTagger(pictureAttr: string, scopeAttr: string) {
  let pictures = new Map<Element, string>();
  let scopes = new Set<Element>();

  function apply(marked: Iterable<readonly [Element, string]>) {
    const nextPictures = new Map<Element, string>();
    const nextScopes = new Set<Element>();
    for (const [a, value] of marked) {
      const found = picturesOf(a);
      for (const el of found.pictures) nextPictures.set(el, value);
      if (found.scope) nextScopes.add(found.scope);
    }
    for (const el of pictures.keys()) if (!nextPictures.has(el)) el.removeAttribute(pictureAttr);
    for (const el of scopes) if (!nextScopes.has(el)) el.removeAttribute(scopeAttr);
    for (const [el, value] of nextPictures) if (el.getAttribute(pictureAttr) !== value) el.setAttribute(pictureAttr, value);
    for (const el of nextScopes) if (!el.hasAttribute(scopeAttr)) el.setAttribute(scopeAttr, '');
    pictures = nextPictures;
    scopes = nextScopes;
  }

  return { apply, clear: () => apply([]) };
}
