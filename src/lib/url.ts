/** Query params that never change which page is shown. Matched case-insensitively. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'spm',
  'si',
  'ref',
  'ref_src',
  'ref_url',
]);

const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_'];

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Canonical form of a URL, used as a lookup key.
 *
 * - only http(s) is supported; anything else (chrome://, file://, invalid input) returns null
 * - the scheme is dropped, so http and https versions of a page match
 * - host lowercased, leading "www." and trailing "." removed, default port dropped
 * - #hash and tracking params removed, remaining params sorted by name then value
 * - trailing slash removed (the bare root becomes just the host)
 *
 * Path case is kept: paths are case-sensitive on most servers.
 *
 * Example: "https://WWW.Site.com/a/?b=2&utm_source=x&a=1#top" -> "site.com/a?a=1&b=2"
 */
export function normalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host) return null;
  if (u.port) host += `:${u.port}`;

  const path = u.pathname.replace(/\/+$/, '');

  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  params.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';

  return `${host}${path}${query}`;
}

/**
 * Default series root suggested for a prefix record: the page URL minus its last
 * path segment. "site.com/novel/abc/chapter-3" -> "site.com/novel/abc".
 */
export function suggestPrefix(normalized: string): string {
  const noQuery = normalized.split('?', 1)[0] ?? normalized;
  const cut = noQuery.lastIndexOf('/');
  return cut === -1 ? noQuery : noQuery.slice(0, cut);
}

/** Short site label for display: lowercase host without "www.", or "" if the URL is invalid. */
export function siteLabel(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** Stable hue (0–359) for a string, used to tint placeholders per site. */
export function hueFor(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * URL of a page's site icon from Chrome's favicon cache (needs the "favicon" permission).
 * `base` is the extension's `/_favicon/` URL. Chrome answers with a generic globe for
 * pages it has no icon for. No network request is made.
 */
export function faviconUrl(base: string, pageUrl: string, size = 32): string {
  const u = new URL(base);
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}
