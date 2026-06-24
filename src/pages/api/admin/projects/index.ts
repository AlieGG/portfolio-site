import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson } from '../../../../lib/api';
import { getAllProjects, createProject, type ProjectInput } from '../../../../lib/db';

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
  return json(await getAllProjects(env.DB));
};

export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const body = await readJson<any>(ctx.request);
  const input = validate(body);
  if (!input) return json({ error: 'title is required' }, 400);
  const id = await createProject(env.DB, input);
  return json({ id }, 201);
};
