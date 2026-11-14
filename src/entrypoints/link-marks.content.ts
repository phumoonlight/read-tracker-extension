import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { onRecordsChanged } from '@/lib/changes';
import { getMarkingPrefs, onMarkingPrefsChanged } from '@/lib/marking-prefs';
import {
  LINK_MARK_ATTR,
  LINK_MARKS_BATCH,
  LINK_MARKS_MESSAGE,
  MARK_SHOWN_CSS,
  MARK_TRANSITION_CSS,
  markCss,
  type LinkMark,
  type LinkMarksRequest,
} from '@/lib/link-marks';

/**
 * Dims links to records whose place has link marking on. Registered by the background
 * at runtime (never in the manifest) only while some place marks links and the host
 * permission is granted. The page is only read for link URLs; matching happens in the
 * background (one batched lookup per change), and the only change made to the page is the
 * LINK_MARK_ATTR attribute on <a> elements plus one <style>.
 */
export default defineContentScript({
  registration: 'runtime',
  // Don't post a "script started" message to the page's window (WXT's old behavior).
  noScriptStartedPostMessage: true,
  main() {
    // Injected again into already-open tabs when marking is turned on: run once per page.
    const flag = '__readTrackerLinkMarks';
    const w = window as unknown as Record<string, boolean>;
    if (w[flag]) return;
    w[flag] = true;

    const STYLE_ID = 'read-tracker-link-marks';
    // Replace a style an older build left in this tab (its rules may differ).
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    {
      style.id = STYLE_ID;
      // Dimmed and blurred (MARK_LOOK: read the most). A link that wraps a picture dims the picture, not the link: opacity / filter on the link
      // make it a stacking context, and on sites like pixiv that put the thumbnail under the
      // card's placeholder layer (gone instead of dimmed).
      const dimmed = (a: string) => `${a}:not(:has(img)),${a} img`;
      const rule = (mark: LinkMark) => `${dimmed(`a[${LINK_MARK_ATTR}="${mark}"]`)}{${markCss(mark)}}`;
      // Hovering (or keyboard focus) shows the link sharp and fully visible again.
      const marked = `a[${LINK_MARK_ATTR}]`;
      const shown = [':hover', ':focus-visible'].flatMap((s) => [`${marked}${s}`, `${marked}${s} img`]).join(',');
      style.textContent =
        rule('unread') +
        rule('read') +
        `${dimmed(marked)}{${MARK_TRANSITION_CSS}}` +
        `${shown}{${MARK_SHOWN_CSS}}`;
      (document.head ?? document.documentElement).append(style);
    }

    // The popup's global marking switch: while paused the style is off (media "not all"), so
    // nothing is dimmed; the attributes stay, so resuming shows the marks at once.
    const applyPrefs = (paused: boolean) => (style.media = paused ? 'not all' : '');
    getMarkingPrefs().then(
      (p) => applyPrefs(!!p.paused),
      () => {},
    );
    const unsubscribePrefs = onMarkingPrefsChanged((p) => applyPrefs(!!p.paused));

    /** Mark per link URL, as last answered by the background (null = not marked). */
    const marks = new Map<string, LinkMark | null>();
    /** Bumped when records change, so answers to an older question aren't kept. */
    let generation = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    let again = false;

    const linkUrl = (a: HTMLAnchorElement) => (/^https?:/i.test(a.href) ? a.href.split('#')[0] : null);

    async function ask(urls: string[]) {
      const asked = generation;
      for (let i = 0; i < urls.length; i += LINK_MARKS_BATCH) {
        const chunk = urls.slice(i, i + LINK_MARKS_BATCH);
        const msg: LinkMarksRequest = { type: LINK_MARKS_MESSAGE, urls: chunk };
        const res = (await browser.runtime.sendMessage(msg)) as (LinkMark | null)[] | null | undefined;
        if (asked !== generation) return;
        chunk.forEach((u, j) => marks.set(u, res?.[j] ?? null));
      }
    }

    async function scan() {
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
      const unknown = new Set<string>();
      for (const a of links) {
        const u = linkUrl(a);
        if (u && !marks.has(u)) unknown.add(u);
      }
      if (unknown.size) await ask([...unknown]);
      for (const a of links) {
        const u = linkUrl(a);
        const mark = u ? marks.get(u) : null;
        if (mark) {
          if (a.getAttribute(LINK_MARK_ATTR) !== mark) a.setAttribute(LINK_MARK_ATTR, mark);
        } else if (a.hasAttribute(LINK_MARK_ATTR)) {
          a.removeAttribute(LINK_MARK_ATTR);
        }
      }
    }

    /** One scan at a time; a request during a scan runs one more after it. */
    function run() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = scan()
        .catch(() => {
          // The extension was reloaded or removed: this copy can't reach it any more.
          stop();
        })
        .finally(() => {
          running = undefined;
          if (again) {
            again = false;
            run();
          }
        });
    }

    // Throttled, not debounced: a page that changes all the time still gets scanned.
    function schedule() {
      timer ??= setTimeout(() => {
        timer = undefined;
        run();
      }, 300);
    }

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    // Records or settings changed (in any context): ask again for every link.
    const unsubscribe = onRecordsChanged(() => {
      generation++;
      marks.clear();
      schedule();
    });

    function stop() {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
      try {
        unsubscribe();
        unsubscribePrefs();
      } catch {
        // Extension context already gone.
      }
    }

    run();
  },
});
