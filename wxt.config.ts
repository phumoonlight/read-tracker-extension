import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Read Tracker',
    description: 'A local-only reading list. Shows the read state of the current page.',
    // favicon: read Chrome's stored site icons (chrome-extension://<id>/_favicon/) to show next to the site name.
    permissions: ['storage', 'unlimitedStorage', 'tabs', 'activeTab', 'scripting', 'favicon'],
    // Requested at runtime, per origin, only when an og:image lives on a CDN
    // that blocks cross-origin downloads. Never granted at install time.
    optional_host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Read Tracker',
    },
  },
});
