import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import {
  listCulledImages,
  insertBatch,
  markImagesPending,
} from '../../../../../../lib/pipeline-db';
import { submitVlmBatch, type VlmBatchItem } from '../../../../../../lib/ai-pipeline';
import { r2ObjectToDataUrl } from '../../../../../../lib/r2-pipeline';

export const prerender = false;

// POST /api/admin/pipeline/groups/[id]/submit-batch
// Queues all 'culled' images in the group to the Workers AI async batch API.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const images = await listCulledImages(env.DB, id);
  if (!images.length) return json({ error: 'no culled images to submit' }, 400);

  // Read bytes from R2 and inline as data URLs (no public URL / S3 creds needed).
  const items: VlmBatchItem[] = [];
  for (const img of images) {
    const dataUrl = await r2ObjectToDataUrl(env, img.r2_key);
    if (dataUrl) items.push({ id: img.id, dataUrl });
  }
  if (!items.length) return json({ error: 'could not read images from R2' }, 502);

  let cfBatchId: string;
  try {
    cfBatchId = await submitVlmBatch(env, items);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  const batchId = crypto.randomUUID();
  const imageIds = items.map((it) => it.id);
  await insertBatch(env.DB, {
    id: batchId,
    batch_type: 'vlm_caption',
    cf_batch_id: cfBatchId,
    group_id: id,
    status: 'submitted',
    image_ids: imageIds,
  });
  await markImagesPending(env.DB, imageIds, batchId);

  return json({ batchId, imageCount: imageIds.length });
};
