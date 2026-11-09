import { describe, expect, it } from 'vitest';
import { addDomainText, domainConflictError, folderForUrl, hostMatchesDomain, normalizeDomain } from '@/lib/domains';
import type { Folder } from '@/lib/types';

const folder = (id: string, name: string, domains?: string[]): Folder => ({
  id,
  name,
  ...(domains ? { domains } : {}),
  createdAt: 1,
  updatedAt: 1,
});

describe('normalizeDomain', () => {
  it.each([
    ['x.com', 'x.com'],
    ['  X.COM ', 'x.com'],
    ['www.youtube.com', 'youtube.com'],
    ['https://www.x.com/akaoni2gou?x=1#y', 'x.com'],
    ['http://blog.example.com:8080/a', 'blog.example.com'],
    ['*.pixiv.net', 'pixiv.net'],
    ['example.com.', 'example.com'],
    ['localhost', 'localhost'],
  ])('%j -> %s', (input, out) => {
    expect(normalizeDomain(input)).toBe(out);
  });
  it.each(['', '   ', 'not a domain', 'com', 'a..b', 'exa mple.com', 'https://'])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});

describe('addDomainText', () => {
  it('adds comma or space separated domains, normalized, without duplicates or invalid ones', () => {
    expect(addDomainText(['x.com'], 'https://www.X.com/a, youtube.com  pixiv.net, nonsense')).toEqual([
      'x.com',
      'youtube.com',
      'pixiv.net',
    ]);
  });
});

describe('hostMatchesDomain', () => {
  it('matches the exact domain only (no subdomains)', () => {
    expect(hostMatchesDomain('x.com', 'x.com')).toBe(true);
    expect(hostMatchesDomain('mobile.x.com', 'x.com')).toBe(false);
    expect(hostMatchesDomain('notx.com', 'x.com')).toBe(false);
    expect(hostMatchesDomain('x.com.evil.org', 'x.com')).toBe(false);
  });
});

describe('folderForUrl', () => {
  const folders = [folder('a', 'Artists', ['x.com', 'pixiv.net']), folder('v', 'Video', ['youtube.com']), folder('n', 'None')];
  it('picks the folder whose domain is the page host ("www." ignored)', () => {
    expect(folderForUrl(folders, 'https://www.x.com/akaoni2gou')?.id).toBe('a');
    expect(folderForUrl(folders, 'https://youtube.com/watch?v=1')?.id).toBe('v');
  });
  it('does not count subdomains', () => {
    expect(folderForUrl(folders, 'https://m.youtube.com/watch?v=1')).toBeUndefined();
  });
  it('returns undefined when nothing matches (the page goes to Home)', () => {
    expect(folderForUrl(folders, 'https://github.com/x')).toBeUndefined();
    expect(folderForUrl(folders, 'not a url')).toBeUndefined();
  });
  it('treats a subdomain as its own domain', () => {
    const fs = [folder('g', 'Google', ['google.com']), folder('docs', 'Docs', ['docs.google.com'])];
    expect(folderForUrl(fs, 'https://docs.google.com/x')?.id).toBe('docs');
    expect(folderForUrl(fs, 'https://mail.google.com/x')).toBeUndefined();
  });
});

describe('domainConflictError', () => {
  const folders = [folder('a', 'Artists', ['x.com']), folder('v', 'Video', ['youtube.com'])];
  it('reports a domain another folder already prefers', () => {
    expect(domainConflictError(['pixiv.net', 'youtube.com'], folders, 'a')).toMatch(/youtube\.com.*Video/);
  });
  it("ignores the folder's own domains and returns null when free", () => {
    expect(domainConflictError(['x.com', 'pixiv.net'], folders, 'a')).toBeNull();
  });
});
