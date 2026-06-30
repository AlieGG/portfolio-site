import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../../lib/api';
import { splitGroup, getGroup } from '../../../../../../lib/pipeline-db';

export const prerender = false;

// POST /api/admin/pipeline/groups/[id]/split  { imageIds: number[] }
// Creates a new proposed group and moves the named images into it.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const body = await readJson<{ imageIds?: unknown }>(ctx.request);
  const imageIds = Array.isArray(body?.imageIds)
    ? body!.imageIds.map(Number).filter(Number.isInteger)
    : [];
  if (!imageIds.length) return json({ error: 'imageIds required' }, 400);

  const group = await getGroup(env.DB, id);
  if (!group) return json({ error: 'group not found' }, 404);

  const newId = await splitGroup(env.DB, id, imageIds);
  return json({ groupId: newId }, 201);
};
