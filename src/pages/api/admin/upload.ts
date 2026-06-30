import type { APIRoute } from 'astro';
import { json, requireAdmin } from '../../../lib/api';
import { getDirectUploadUrl } from '../../../lib/images';

export const prerender = false;

// Returns a one-time Cloudflare Images direct-upload URL. The browser uploads
// the file straight to Cloudflare, then registers the returned id via the
// images endpoint. Keeps large uploads off the Worker.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  try {
    const upload = await getDirectUploadUrl(env);
    return json(upload);
  } catch (err) {
    return json({ error: (err as Error).message }, 502);
  }
};
