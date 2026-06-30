import type { APIRoute } from 'astro';
import { json, requireAdmin } from '../../../../../lib/api';
import { listGroups } from '../../../../../lib/pipeline-db';
import { reconcileWithLock } from '../../../../../lib/batch-reconcile';

export const prerender = false;

// GET /api/admin/pipeline/groups?status=proposed
// Returns groups (with image_count). Opportunistically nudges in-flight batches
// forward via waitUntil so progress advances just by opening the pipeline page.
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;

  const status = ctx.url.searchParams.get('status') || undefined;
  const groups = await listGroups(env.DB, status ?? undefined);

  ctx.locals.runtime.ctx.waitUntil(reconcileWithLock(env).catch(() => {}));

  return json({ groups });
};
