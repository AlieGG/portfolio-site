import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import {
  listCulledImages,
  listRawImagesByGroup,
  insertBatch,
  markImagesPending,
} from '../../../../../../lib/pipeline-db';
import { reconcileWithLock } from '../../../../../../lib/batch-reconcile';

export const prerender = false;

// POST /api/admin/pipeline/groups/[id]/submit-batch
// Marks all 'culled' images in the group for captioning and returns
// immediately. The actual VLM work happens incrementally in reconcile ticks —
// a few plain (fast) AI calls per tick, driven by the UI's poll — with the
// async queue as fallback if sync calls keep failing. Images move
// culled → vlm_pending → vlm_done as they're processed, so the grid can live-
// update. Pressing the button twice is safe: the second call finds no culled
// images and reports what's already in flight.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const images = await listCulledImages(env.DB, id);
  if (!images.length) {
    // Distinguish "nothing to do" from "already running" so the UI can say so.
    const all = await listRawImagesByGroup(env.DB, id);
    const inFlight = all.filter((i) => i.pipeline_status === 'vlm_pending').length;
    if (inFlight) return json({ error: `captioning already in progress (${inFlight} images)` }, 409);
    return json({ error: 'no culled images to submit' }, 400);
  }

  const batchId = crypto.randomUUID();
  const imageIds = images.map((img) => img.id);
  await insertBatch(env.DB, {
    id: batchId,
    batch_type: 'vlm_sync',
    cf_batch_id: null,
    group_id: id,
    status: 'processing',
    image_ids: imageIds,
  });
  await markImagesPending(env.DB, imageIds, batchId);

  // Kick the first captioning tick right away instead of waiting for a poll.
  ctx.locals.runtime.ctx.waitUntil(reconcileWithLock(env).catch(() => {}));

  return json({ batchId, batchIds: [batchId], imageCount: imageIds.length });
};
