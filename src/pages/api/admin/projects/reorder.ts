import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson } from '../../../../lib/api';
import { reorderProjects } from '../../../../lib/db';

export const prerender = false;

// Body: { ids: number[] } in the desired display order.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const body = await readJson<{ ids?: unknown }>(ctx.request);
  const ids = Array.isArray(body?.ids) ? body!.ids.filter((n) => Number.isInteger(n)) : null;
  if (!ids) return json({ error: 'ids array required' }, 400);
  await reorderProjects(env.DB, ids as number[]);
  return json({ ok: true });
};
