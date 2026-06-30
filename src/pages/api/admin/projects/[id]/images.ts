import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../lib/api';
import { addImage, getProject } from '../../../../../lib/db';

export const prerender = false;

// Register an already-uploaded Cloudflare image against a project.
// Body: { cf_image_id: string, subtitle?: string }
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const projectId = parseId(ctx.params);
  if (!projectId) return json({ error: 'bad id' }, 400);

  const body = await readJson<{ cf_image_id?: unknown; subtitle?: unknown }>(ctx.request);
  const cfId = typeof body?.cf_image_id === 'string' ? body.cf_image_id.trim() : '';
  if (!cfId) return json({ error: 'cf_image_id required' }, 400);

  const project = await getProject(env.DB, projectId);
  if (!project) return json({ error: 'project not found' }, 404);

  const subtitle = typeof body?.subtitle === 'string' ? body.subtitle : null;
  const id = await addImage(env.DB, projectId, cfId, subtitle);
  return json({ id }, 201);
};
