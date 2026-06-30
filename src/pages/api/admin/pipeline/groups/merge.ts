import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson } from '../../../../../lib/api';
import { mergeGroups, getGroup } from '../../../../../lib/pipeline-db';

export const prerender = false;

// POST /api/admin/pipeline/groups/merge  { sourceId, targetId }
// Moves all of source's images into target, then deletes source.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;

  const body = await readJson<{ sourceId?: unknown; targetId?: unknown }>(ctx.request);
  const sourceId = Number(body?.sourceId);
  const targetId = Number(body?.targetId);
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId === targetId) {
    return json({ error: 'sourceId and targetId required and must differ' }, 400);
  }
  const [source, target] = await Promise.all([getGroup(env.DB, sourceId), getGroup(env.DB, targetId)]);
  if (!source || !target) return json({ error: 'group not found' }, 404);

  await mergeGroups(env.DB, sourceId, targetId);
  return json({ ok: true });
};
