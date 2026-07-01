import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import { getRawImage } from '../../../../../../lib/pipeline-db';
import { r2ObjectResponse } from '../../../../../../lib/r2-pipeline';

export const prerender = false;

// GET /api/admin/pipeline/images/[id]/raw
// Streams a raw archive image straight from R2 (behind Cloudflare Access). Used
// as <img src> in the pipeline UI; R2 has no public CDN so we proxy via the worker.
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const img = await getRawImage(env.DB, id);
  if (!img) return json({ error: 'not found' }, 404);

  const res = await r2ObjectResponse(env, img.r2_key);
  return res ?? json({ error: 'object missing in R2' }, 404);
};
