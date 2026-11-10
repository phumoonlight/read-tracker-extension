import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { onRecordsChanged } from '@/lib/changes';
import {
  LINK_MARK_ATTR,
  LINK_MARKS_BATCH,
  LINK_MARKS_MESSAGE,
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
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // Dimmed (opacity: unread 0.5, read 0.2, so read is the most dimmed) and blurred (unread 1px,
      // read 2px), and the link's text glows in the badge colors (blue unread, green read).
      // base.css tokens don't exist on web pages, so the colors are here.
      const rule = (mark: LinkMark, opacity: number, blur: number, glow: string) => {
        const a = `a[${LINK_MARK_ATTR}="${mark}"]`;
        return (
          `${a}{opacity:${opacity}!important;filter:blur(${blur}px)!important}` +
          `${a},${a} *{text-shadow:0 0 3px ${glow},0 0 8px ${glow}!important}`
        );
      };
      style.textContent = rule('unread', 0.5, 1, '#0969da') + rule('read', 0.2, 2, '#1a7f37');
      (document.head ?? document.documentElement).append(style);
    }

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
      } catch {
        // Extension context already gone.
      }
    }

    run();
  },
});
