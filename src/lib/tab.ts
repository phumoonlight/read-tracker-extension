import { browser, type Browser } from 'wxt/browser';
import { LINK_MARK_ORIGINS } from './link-marks';

export async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Screenshot of the visible part of the tab. Works from the popup because opening
 * it grants activeTab for the current page.
 */
export async function captureVisible(windowId: number): Promise<Blob> {
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  return (await fetch(dataUrl)).blob();
}

/** Read og:image / twitter:image from the page (absolute URL), or null. */
export async function findOgImage(tabId: number): Promise<string | null> {
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sel = [
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image"]',
        'meta[name="og:image"]',
        'meta[name="twitter:image"]',
        'meta[property="twitter:image"]',
      ];
      for (const s of sel) {
        const c = document.querySelector<HTMLMetaElement>(s)?.content?.trim();
        if (c) return new URL(c, document.baseURI).href;
      }
      return null;
    },
  });
  return (res?.result as string | null | undefined) ?? null;
}

export class NeedsPermissionError extends Error {
  constructor(public origin: string) {
    super(`The site blocks downloading this image. Grant access to ${origin} and try again.`);
  }
}

/**
 * Download an image. Tries the extension context first (works for same-origin images
 * via activeTab, CORS-enabled CDNs, or origins already granted), then from inside the
 * page. If both fail, throws NeedsPermissionError so the UI can offer to request the
 * optional host permission for that origin.
 */
export async function downloadImage(imageUrl: string, tabId: number): Promise<Blob> {
  try {
    const r = await fetch(imageUrl, { credentials: 'omit' });
    if (r.ok) return await r.blob();
  } catch {
    // fall through
  }
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      args: [imageUrl],
      func: async (url: string) => {
        const r = await fetch(url);
        if (!r.ok) return null;
        const blob = await r.blob();
        return await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
      },
    });
    const dataUrl = res?.result as string | null | undefined;
    if (dataUrl) return await (await fetch(dataUrl)).blob();
  } catch {
    // fall through
  }
  throw new NeedsPermissionError(new URL(imageUrl).origin);
}

/** Must be called from a user gesture. */
export function requestOriginAccess(origin: string): Promise<boolean> {
  return browser.permissions.request({ origins: [`${origin}/*`] });
}

/**
 * Access to every http(s) site, for link marking (the optional host permission). Must be
 * called from a user gesture, before any other await.
 */
export function requestLinkMarkAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: LINK_MARK_ORIGINS });
}

export function hasLinkMarkAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: LINK_MARK_ORIGINS });
}
