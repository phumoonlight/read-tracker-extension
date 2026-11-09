import type { Folder } from './types';

/**
 * A folder's "preferred domains": adding a page whose host is on one of them preselects
 * that folder (otherwise Home). Each domain belongs to at most one folder.
 */

/**
 * Normalize user input to a bare domain: lowercase host, no scheme / path / port, no
 * leading "www." or "*.", no trailing dot. Accepts "x.com", "https://www.x.com/a", "*.x.com".
 * Returns null for anything that isn't a plausible host name.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/, 1)[0] ?? ''; // path, query, hash
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s)) return null;
  if (!s.includes('.') && s !== 'localhost') return null;
  return s;
}

/** Add domains typed or pasted as text ("x.com, youtube.com"): normalized, invalid ones dropped, no duplicates. */
export function addDomainText(current: readonly string[], text: string): string[] {
  const out = [...current];
  for (const part of text.split(/[,\s]+/)) {
    const d = normalizeDomain(part);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * True if `host` (already lowercase, without "www.") is exactly `domain`. Subdomains don't
 * count: "x.com" matches x.com and www.x.com, not mobile.x.com.
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain;
}

/** Host of a URL for domain matching: lowercase, without "www." (empty for invalid URLs). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** The folder that prefers this URL's domain (exact host, "www." ignored), if any. Domains are unique, so at most one. */
export function folderForUrl(folders: readonly Folder[], url: string): Folder | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  return folders.find((f) => (f.domains ?? []).some((d) => hostMatchesDomain(host, d)));
}

/**
 * First domain in `domains` that another folder already prefers, as a user-facing error,
 * or null. `exceptId` is the folder being edited.
 */
export function domainConflictError(
  domains: readonly string[],
  folders: readonly Folder[],
  exceptId?: string,
): string | null {
  for (const d of domains) {
    const owner = folders.find((f) => f.id !== exceptId && (f.domains ?? []).includes(d));
    if (owner) return `${d} is already a preferred domain of “${owner.name}”.`;
  }
  return null;
}
