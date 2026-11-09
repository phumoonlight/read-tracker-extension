import { browser } from 'wxt/browser';
import { displayUrl, faviconUrl } from '@/lib/url';

// Built once: chrome-extension://<id>/_favicon/ (not a file in the build, so not in WXT's path types).
const FAVICON_BASE = browser.runtime.getURL('/_favicon/' as '/');

/**
 * A record URL as a link: the site's icon (from Chrome's favicon cache) and a short form
 * of the address (site + path). Long addresses are cut with an ellipsis; the full URL is
 * in the tooltip. `prefix` is text shown before the address (e.g. "Last: ").
 */
export function UrlLink({ url, prefix }: { url: string; prefix?: string }) {
  return (
    <a className="url-link" href={url} target="_blank" rel="noreferrer" title={url}>
      <img className="site-icon" src={faviconUrl(FAVICON_BASE, url)} alt="" width={14} height={14} loading="lazy" />
      <span className="url-link-text">
        {prefix}
        {displayUrl(url)}
      </span>
    </a>
  );
}
