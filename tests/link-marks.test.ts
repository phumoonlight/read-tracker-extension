import { describe, expect, it } from 'vitest';
import { isLinkMarksRequest, LINK_MARKS_MESSAGE, linkMark, markCss, marksLinks } from '@/lib/link-marks';
import type { Folder } from '@/lib/types';
import { rec } from './fixtures';

const folder = (over: Partial<Folder> = {}): Folder => ({ id: 'f', name: 'F', createdAt: 1, updatedAt: 1, ...over });

describe('linkMark', () => {
  it('is null when the place does not mark links (off by default)', () => {
    expect(linkMark(rec(), undefined)).toBeNull();
    expect(linkMark(rec(), { updatedAt: 1 })).toBeNull();
    expect(linkMark(rec({ status: 'read' }), folder())).toBeNull();
    expect(linkMark(rec(), folder({ markLinks: false }))).toBeNull();
  });

  it('follows the status in Status places (Home and folders)', () => {
    expect(linkMark(rec({ status: 'unread' }), { markLinks: true, updatedAt: 1 })).toBe('unread');
    expect(linkMark(rec({ status: 'read' }), { markLinks: true, updatedAt: 1 })).toBe('read');
    expect(linkMark(rec({ status: 'unread' }), folder({ markLinks: true }))).toBe('unread');
    expect(linkMark(rec({ status: 'read' }), folder({ markLinks: true, readMode: 'status' }))).toBe('read');
  });

  it('counts every record as read in Revisit places', () => {
    const revisit = folder({ markLinks: true, readMode: 'revisit' });
    expect(linkMark(rec({ status: 'unread' }), revisit)).toBe('read');
    expect(linkMark(rec({ status: 'read' }), revisit)).toBe('read');
  });
});

describe('marksLinks', () => {
  it('is true when Home or any folder has marking on', () => {
    expect(marksLinks([], undefined)).toBe(false);
    expect(marksLinks([folder()], { updatedAt: 1 })).toBe(false);
    expect(marksLinks([folder()], { markLinks: true, updatedAt: 1 })).toBe(true);
    expect(marksLinks([folder(), folder({ id: 'g', markLinks: true })], undefined)).toBe(true);
  });
});

describe('isLinkMarksRequest', () => {
  it('accepts only the link marks message with string URLs', () => {
    expect(isLinkMarksRequest({ type: LINK_MARKS_MESSAGE, urls: ['https://a.com'] })).toBe(true);
    expect(isLinkMarksRequest({ type: LINK_MARKS_MESSAGE, urls: [1] })).toBe(false);
    expect(isLinkMarksRequest({ type: 'other', urls: [] })).toBe(false);
    expect(isLinkMarksRequest(null)).toBe(false);
  });
});

describe('markCss', () => {
  it('dims and blurs, read the most, with no text colour', () => {
    expect(markCss('unread')).toBe('opacity:0.5!important;filter:blur(1px)!important');
    expect(markCss('read')).toBe('opacity:0.2!important;filter:blur(2px)!important');
    expect(markCss('read')).not.toMatch(/shadow|color/);
  });
});
