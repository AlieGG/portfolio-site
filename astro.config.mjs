// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Astro 5 + Cloudflare Workers (SSR). The animation engine is the only client
// JS we ship; everything else is server-rendered HTML so first paint is fast.
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Expose wrangler.jsonc bindings (DB, vars, secrets) to `Astro.locals.runtime`
    // during `astro dev`, backed by Miniflare's local simulators.
    platformProxy: { enabled: true },
    // We deliver project media straight from Cloudflare Images (remote URLs) and
    // pre-optimize the static portraits ourselves, so no runtime image service.
    imageService: 'passthrough',
  }),
  vite: {
    // Keep the worker bundle lean.
    build: { assetsInlineLimit: 0 },
  },
});
