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
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    // Set by middleware after validating the Cloudflare Access header.
    adminEmail: string | null;
  }
}
