import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../lib/api';
import { updateProject, deleteProject, getProject, type ProjectInput } from '../../../../lib/db';
import { deleteCfImage } from '../../../../lib/images';

export const prerender = false;

function validate(body: any): ProjectInput | null {
  if (!body || typeof body.title !== 'string' || !body.title.trim()) return null;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t: unknown) => typeof t === 'string')
    : [];
  return {
    title: body.title.trim(),
    kicker: typeof body.kicker === 'string' ? body.kicker : null,
    index_label: typeof body.index_label === 'string' ? body.index_label : null,
    summary: typeof body.summary === 'string' ? body.summary : null,
    tags,
    accent: typeof body.accent === 'string' ? body.accent : null,
    published: body.published !== false,
  };
}

export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);
  const project = await getProject(env.DB, id);
  return project ? json(project) : json({ error: 'not found' }, 404);
};

export const PUT: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);
  const input = validate(await readJson<any>(ctx.request));
  if (!input) return json({ error: 'title is required' }, 400);
  await updateProject(env.DB, id, input);
  return json({ ok: true });
};

export const DELETE: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);
  const images = await deleteProject(env.DB, id);
  // Best-effort cleanup of the backing Cloudflare Images.
  await Promise.allSettled(images.map((img) => deleteCfImage(env, img.cf_image_id)));
  return json({ ok: true });
};
