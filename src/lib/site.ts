// Site-level configuration read from public environment variables.
// Set these in .env for local dev or in wrangler.jsonc [vars] for production.

const fallback = '#';

/** Instagram profile URL */
export const IG_URL = (import.meta.env.PUBLIC_IG_URL as string | undefined) || fallback;
/** GitHub profile URL */
export const GH_URL = (import.meta.env.PUBLIC_GH_URL as string | undefined) || fallback;
/** LinkedIn profile URL */
export const LI_URL = (import.meta.env.PUBLIC_LI_URL as string | undefined) || fallback;
