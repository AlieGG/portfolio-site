import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import {
  listCulledImages,
  insertBatch,
  markImagesPending,
} from '../../../../../../lib/pipeline-db';
import { submitVlmBatch, chunkVlmItems, type VlmBatchItem } from '../../../../../../lib/ai-pipeline';
import { r2ObjectToVlmDataUrl } from '../../../../../../lib/r2-pipeline';

export const prerender = false;

// POST /api/admin/pipeline/groups/[id]/submit-batch
// Queues all 'culled' images in the group to the Workers AI async batch API.
// Images are downscaled first, and the group is split across as many batch
// submissions as needed to keep each payload under the API's size cap —
// oversized submissions are accepted but never processed (see docs/samples/).
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const images = await listCulledImages(env.DB, id);
  if (!images.length) return json({ error: 'no culled images to submit' }, 400);

  // Read bytes from R2, downscale, inline as data URLs (no public URL needed).
  const items: VlmBatchItem[] = [];
  for (const img of images) {
    const dataUrl = await r2ObjectToVlmDataUrl(env, img.r2_key);
    if (dataUrl) items.push({ id: img.id, dataUrl });
  }
  if (!items.length) return json({ error: 'could not read images from R2' }, 502);

  const batchIds: string[] = [];
  let submitted = 0;
  for (const chunk of chunkVlmItems(items)) {
    let cfBatchId: string;
    try {
      cfBatchId = await submitVlmBatch(env, chunk);
    } catch (e) {
      // Report partial progress; already-submitted chunks keep reconciling.
      return json(
        { error: (e as Error).message, batchIds, imageCount: submitted },
        batchIds.length ? 207 : 502
      );
    }
    const batchId = crypto.randomUUID();
    const imageIds = chunk.map((it) => it.id);
    await insertBatch(env.DB, {
      id: batchId,
      batch_type: 'vlm_caption',
      cf_batch_id: cfBatchId,
      group_id: id,
      status: 'submitted',
      image_ids: imageIds,
    });
    await markImagesPending(env.DB, imageIds, batchId);
    batchIds.push(batchId);
    submitted += imageIds.length;
  }

  // batchId kept for backwards compatibility with the single-batch UI shape.
  return json({ batchId: batchIds[0], batchIds, imageCount: submitted });
};
