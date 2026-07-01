import type { APIRoute } from 'astro';
import { json, requireAdmin } from '../../../../../lib/api';
import { getBatch } from '../../../../../lib/pipeline-db';

export const prerender = false;

// GET /api/admin/pipeline/batches/[id] → batch status row.
// [id] here is the pipeline_batches UUID (a string), so parseId is not used.
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = ctx.params.id;
  if (!id) return json({ error: 'bad id' }, 400);

  const batch = await getBatch(env.DB, id);
  if (!batch) return json({ error: 'not found' }, 404);
  return json({ batch });
};
