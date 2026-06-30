import type { APIRoute } from 'astro';
import { json, requireAdmin } from '../../../../lib/api';
import { reconcileWithLock } from '../../../../lib/batch-reconcile';

export const prerender = false;

// POST /api/admin/pipeline/reconcile
// Polls all in-flight batches, writes results, advances finished groups. Called
// by the "Reconcile now" button and the UI auto-poll.
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const summary = await reconcileWithLock(env);
  return json(summary);
};
