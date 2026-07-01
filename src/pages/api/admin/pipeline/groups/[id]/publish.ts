import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../../lib/api';
import {
  getGroup,
  getRawImage,
  updateGroup,
  markRawImagesPublished,
} from '../../../../../../lib/pipeline-db';
import { createProject, addImage } from '../../../../../../lib/db';
import { uploadImageFromBytes } from '../../../../../../lib/images';
import { getR2Object } from '../../../../../../lib/r2-pipeline';

export const prerender = false;

// POST /api/admin/pipeline/groups/[id]/publish
// Body: { heroImageIds: number[], title: string, kicker?, accent? }
// Creates a HIDDEN project in the live tables, uploads hero images to Cloudflare
// Images, and links the group. The admin flips Published later in /admin.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const body = await readJson<{
    heroImageIds?: unknown;
    title?: unknown;
    kicker?: unknown;
    accent?: unknown;
  }>(ctx.request);

  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) return json({ error: 'title required' }, 400);
  const heroImageIds = Array.isArray(body?.heroImageIds)
    ? body!.heroImageIds.map(Number).filter(Number.isInteger)
    : [];
  if (!heroImageIds.length) return json({ error: 'heroImageIds required' }, 400);

  const group = await getGroup(env.DB, id);
  if (!group) return json({ error: 'not found' }, 404);
  if (group.status !== 'confirmed') return json({ error: 'group must be confirmed' }, 409);
  if (!group.description_final) return json({ error: 'description_final not set' }, 409);

  // 1. Create the project (hidden until reviewed in /admin).
  const projectId = await createProject(env.DB, {
    title,
    kicker: typeof body?.kicker === 'string' ? body.kicker : null,
    summary: group.description_final,
    tags: group.tags_final,
    accent: typeof body?.accent === 'string' ? body.accent : null,
    published: false,
  });

  // 2. Upload hero images (in order) from R2 → Cloudflare Images → project_images.
  for (const rawId of heroImageIds) {
    const img = await getRawImage(env.DB, rawId);
    if (!img) continue;
    const obj = await getR2Object(env, img.r2_key);
    if (!obj) continue;
    try {
      const cfId = await uploadImageFromBytes(env, obj.bytes, obj.contentType);
      await addImage(env.DB, projectId, cfId, img.vlm_caption ?? null);
    } catch (e) {
      console.warn(`publish: image ${rawId} failed: ${(e as Error).message}`);
    }
  }

  // 3. Advance state.
  await updateGroup(env.DB, id, { status: 'published', project_id: projectId });
  await markRawImagesPublished(env.DB, heroImageIds);

  return json({ projectId });
};
