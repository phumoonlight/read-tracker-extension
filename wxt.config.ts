import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Read Tracker',
    description: 'A local-only reading list. Shows the read state of the current page.',
    // Public key: pins the extension ID to dbdkjjjmnbpfmfgfbmcgkmledmnmbamj in any folder / on any PC, so data
    // (stored per ID) survives reloading from a new path. The private key is kept outside the repo.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApOZ4WJMbFJZu0kP0lduNe5asoBPEVsY9Ir2F5Bn5Z0Iy6G2avKPpxZOUFeR3QaWnJeThEkXphvVYatDqTEfoUjlR3Pc1be0nkr8Ii8IOQnskIa3oeRm+7U7mLpIbGHjCV/994ksy4u4uqskmjXwHwLdAlmumufTMGAAQqSlFCsZaFN9oVRaTgMSG4uw03JCl3dXly154FscrfX6ctO8cK4MsejvvATnK4oKF4DTRUc4b1iLMXoB9xD9p/QAWSrFtG5rN8FDyWtjeBYD7Rmb3UeRJ/nN3+SjCJC/vMqi6/s2S9aGOUppAaUQxrb5B+u64cA2+3vO5Cl67qLNfv0aJ3wIDAQAB',
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
