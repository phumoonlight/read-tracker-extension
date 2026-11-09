import { browser } from 'wxt/browser';
import { faviconUrl, siteLabel } from '@/lib/url';

// Built once: chrome-extension://<id>/_favicon/ (not a file in the build, so not in WXT's path types).
const FAVICON_BASE = browser.runtime.getURL('/_favicon/' as '/');

/** Site icon (from Chrome's favicon cache) followed by the site's domain. */
export function SiteLabel({ url }: { url: string }) {
  const site = siteLabel(url);
  if (!site) return null;
  return (
    <span className="site-label">
      <img className="site-icon" src={faviconUrl(FAVICON_BASE, url)} alt="" width={14} height={14} loading="lazy" />
      {site}
    </span>
  );
}
