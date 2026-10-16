import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { brandPortalHtml } from './src/server/portalBrand';

// `__dirname` does not exist here: package.json declares an ES module, so vite
// loads this config as one.
const page = (name: string): string => fileURLToPath(new URL(`web/${name}`, import.meta.url));

/**
 * The dev server's copy of the portal, branded the way the API server brands
 * the built one (see `servePortal`). Without it, `npm run dev` shows the
 * PartnerDex mark whatever `.env` says. Unvalidated here; the API server
 * checks the same values at startup.
 */
function portalBrand(): Plugin {
  const env = loadEnv('development', process.cwd(), 'PORTAL_');
  const logoUrl = env.PORTAL_LOGO_URL ?? '';
  return {
    name: 'partnerdex-portal-brand',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, context) =>
        context.path.endsWith('/portal.html')
          ? brandPortalHtml(html, {
              name: env.PORTAL_BRAND_NAME ?? '',
              logoUrl,
              faviconUrl: env.PORTAL_FAVICON_URL || logoUrl,
            })
          : html,
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), portalBrand()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Two entries, two audiences. The affiliate portal is a separate bundle so
    // that an external partner's browser is never sent the dashboard's code —
    // see `servePortal` in src/server/index.ts.
    rollupOptions: {
      input: {
        main: page('index.html'),
        portal: page('portal.html'),
      },
    },
  },
  server: {
    proxy: {
      // Order matters: `/portal/api` has to be matched before `/portal` would be
      // handled as a page request by the dev server.
      '/portal/api': 'http://localhost:8787',
      '/api': 'http://localhost:8787',
      '/r': 'http://localhost:8787',
    },
    port: 5173,
  },
});
