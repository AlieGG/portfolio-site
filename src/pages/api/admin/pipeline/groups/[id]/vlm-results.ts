import type { APIRoute } from 'astro';
import { json, requireAdmin, parseId } from '../../../../../../lib/api';
import { resetGroupVlm } from '../../../../../../lib/pipeline-db';

export const prerender = false;

// DELETE /api/admin/pipeline/groups/[id]/vlm-results
// Resets VLM/embedding state so the group can be re-submitted. Images go back to
// 'culled'; published images are untouched.
export const DELETE: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  await resetGroupVlm(env.DB, id);
  return json({ ok: true });
};
