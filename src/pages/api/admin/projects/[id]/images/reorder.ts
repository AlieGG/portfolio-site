import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../../lib/api';
import { reorderImages } from '../../../../../../lib/db';

export const prerender = false;

// Body: { ids: number[] } image ids in desired order within the project.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  if (!parseId(ctx.params)) return json({ error: 'bad id' }, 400);
  const body = await readJson<{ ids?: unknown }>(ctx.request);
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((n) => Number.isInteger(n)) : null;
  if (!ids) return json({ error: 'ids array required' }, 400);
  await reorderImages(env.DB, ids as number[]);
  return json({ ok: true });
};
