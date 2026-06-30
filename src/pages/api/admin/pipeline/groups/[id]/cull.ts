import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import { listRawImagesByGroup, updateRawImageStatus } from '../../../../../../lib/pipeline-db';

export const prerender = false;

const MIN_SHORT_SIDE = 800; // px
const MIN_BYTES = 50 * 1024; // 50 KB

// POST /api/admin/pipeline/groups/[id]/cull
// Deterministic technical cull: resolution + file-size. Survivors → 'culled',
// rejects → 'culled_out'. Blur/exposure are deferred to the VLM quality score.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const images = await listRawImagesByGroup(env.DB, id);
  const reasons: { id: number; reason: string }[] = [];
  let kept = 0;
  let rejected = 0;

  for (const img of images) {
    // Only (re)cull images that haven't progressed past culling.
    if (!['uploaded', 'culled', 'culled_out'].includes(img.pipeline_status)) continue;

    const shortSide = Math.min(img.width ?? 0, img.height ?? 0);
    let reason = '';
    if (img.width && img.height && shortSide < MIN_SHORT_SIDE) {
      reason = `low resolution (${img.width}x${img.height})`;
    } else if (img.file_size_bytes != null && img.file_size_bytes < MIN_BYTES) {
      reason = `tiny file (${img.file_size_bytes} bytes)`;
    }

    if (reason) {
      await updateRawImageStatus(env.DB, img.id, 'culled_out');
      reasons.push({ id: img.id, reason });
      rejected++;
    } else {
      await updateRawImageStatus(env.DB, img.id, 'culled');
      kept++;
    }
  }

  return json({ kept, rejected, reasons });
};
