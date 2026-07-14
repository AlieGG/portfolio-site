import type { APIRoute } from 'astro';
import { json, requireAdmin } from '../../../../../lib/api';
import { getBatch } from '../../../../../lib/pipeline-db';
import { rawPollBatch } from '../../../../../lib/ai-pipeline';

export const prerender = false;

// GET /api/admin/pipeline/batches/[id] → batch status row.
// [id] here is the pipeline_batches UUID (a string), so parseId is not used.
// Add ?raw=1 to also return the untouched Workers AI poll response (diagnostic).
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = ctx.params.id;
  if (!id) return json({ error: 'bad id' }, 400);

  const batch = await getBatch(env.DB, id);
  if (!batch) return json({ error: 'not found' }, 404);

  if (ctx.url.searchParams.get('raw') === '1' && batch.cf_batch_id) {
    const rawPoll = await rawPollBatch(env, batch.cf_batch_id);
    return json({ batch, rawPoll });
  }
  return json({ batch });
};
