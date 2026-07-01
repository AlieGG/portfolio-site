/// <reference path="../.astro/types.d.ts" />

// Bindings + vars available on Astro.locals.runtime.env (Cloudflare adapter).
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CF_IMAGES_ACCOUNT_HASH: string;
  CF_ACCOUNT_ID: string;
  ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. "yourteam.cloudflareaccess.com"
  ACCESS_AUD: string; // Access application audience tag
  CF_IMAGES_TOKEN: string; // secret

  // Image pipeline bindings (see db/pipeline_schema.sql + wrangler.jsonc).
  RAW_IMAGES: R2Bucket; // raw photo archive
  AI: Ai; // Workers AI
  VECTORIZE: VectorizeIndex; // caption embeddings
  PIPELINE_KV: KVNamespace; // reconcile lock + batch-status cache
  AI_GATEWAY_ID: string; // AI Gateway id (var)
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    // Set by middleware after validating the Cloudflare Access header.
    adminEmail: string | null;
  }
}
