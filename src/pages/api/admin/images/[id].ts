import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../lib/api';
import { updateImageSubtitle, deleteImage } from '../../../../lib/db';
import { deleteCfImage } from '../../../../lib/images';

export const prerender = false;

// PATCH body: { subtitle: string | null }
export const PATCH: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);
  const body = await readJson<{ subtitle?: unknown }>(ctx.request);
  const subtitle =
    body && (typeof body.subtitle === 'string' || body.subtitle === null)
      ? (body.subtitle as string | null)
      : null;
  await updateImageSubtitle(env.DB, id, subtitle);
  return json({ ok: true });
};

export const DELETE: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);
  const cfId = await deleteImage(env.DB, id);
  if (cfId) await deleteCfImage(env, cfId).catch(() => {});
  return json({ ok: true });
};
