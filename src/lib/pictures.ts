/**
 * The picture a marked link shows, for sites that draw thumbnails as CSS background images
 * instead of <img> (an <img> is dimmed by `a img` in the content scripts' CSS). Used by both
 * content scripts; only the DOM-walking functions touch the page.
 *
 * - Inside: elements in the link (the link itself included) with a `url(...)` background, when
 *   the link has no <img>.
 * - Outside: a link with nothing of its own to show (an empty overlay stretched over a card)
 *   dims the background picture(s) it covers in the card around it. That card is the
 *   "scope": hovering it counts as hovering the link (the picture may be a sibling of the link,
 *   so it isn't hovered itself).
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

/**
 * The background pictures a link shows. None when it has an <img>: the CSS dims those, and a
 * filter on a background layer beside them (pixiv's placeholder) could paint it over the image.
 */
export function picturesOf(a: Element): Pictures {
  if (a.querySelector('img')) return { pictures: [] };
  const inside = [a, ...a.querySelectorAll('*')].filter(drawsPicture).slice(0, MAX_PICTURES);
  if (inside.length) return { pictures: inside };

  // An overlay: no picture, and no text (or taken out of the flow to sit on top of the card).
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
