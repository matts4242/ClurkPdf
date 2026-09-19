import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The preview build: the real client, with the server replaced by a mock that
 * runs in the browser.
 *
 * One alias is the whole trick. Every module above `src/api/client.ts` — the
 * components, the hooks, the event fold — is built from the same source the
 * real app is, so what the preview shows is the app's own behaviour rather
 * than a second implementation of it that has to be kept in step.
 *
 *   npm run dev:preview     iterate, with HMR
 *   npm run build:preview   -> client/dist-preview/, ready to publish
 *
 * Output is deliberately relative (`base: './'`) so the bundle works from any
 * path, which is what static hosts and Claude artifacts both need.
 *
 * See `src/preview/` for the mock and `docs/preview.md` for how to publish it.
 */

const previewApi = fileURLToPath(new URL('./src/preview/fake-api.ts', import.meta.url));

/** Say on the page itself that none of the data is real. */
function previewBadge(): Plugin {
  return {
    name: 'clurkpdf-preview-badge',
    transformIndexHtml(html) {
      return {
        html: html.replace(
          '<title>Invoice Processor</title>',
          '<title>Invoice Processor · Preview</title>',
        ),
        tags: [
          {
            tag: 'style',
            injectTo: 'head',
            children: `.preview-badge{position:fixed;right:10px;bottom:10px;z-index:9999;
pointer-events:none;border-radius:9999px;background:rgba(15,23,42,.82);color:#e2e8f0;
padding:5px 11px;font:500 11px/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em;
box-shadow:0 1px 3px rgba(15,23,42,.3)}`,
          },
          {
            tag: 'div',
            injectTo: 'body',
            attrs: { class: 'preview-badge' },
            children: 'Preview build · sample data, no server',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  // Relative asset URLs: the bundle has to run from wherever it is served.
  base: './',
  plugins: [react(), tailwindcss(), previewBadge()],
  resolve: {
    alias: [
      // Matches './api/client' from App.tsx and '../api/client' from the
      // hooks and components. Nothing else in src resolves to that path.
      { find: /^(\.{1,2}\/)+api\/client$/, replacement: previewApi },
    ],
  },
  server: {
    // Deliberately not 5173: the preview and the real dev server are worth
    // being able to run side by side.
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    // Nothing debugs the preview from a stack trace, and the maps triple the
    // size of something that gets uploaded.
    sourcemap: false,
  },
});
