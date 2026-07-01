import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../lib/api';
import {
  getGroup,
  listRawImagesByGroup,
  updateGroup,
  type GroupUpdate,
} from '../../../../../lib/pipeline-db';

export const prerender = false;

// GET /api/admin/pipeline/groups/[id] → group + its images
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const group = await getGroup(env.DB, id);
  if (!group) return json({ error: 'not found' }, 404);
  const images = await listRawImagesByGroup(env.DB, id);
  return json({ group, images });
};

// PUT /api/admin/pipeline/groups/[id] → partial update (title/status/interview/etc.)
const ALLOWED: (keyof GroupUpdate)[] = [
  'title',
  'status',
  'description_draft',
  'description_final',
  'tags_draft',
  'tags_final',
  'interview_questions',
  'interview_answers',
];

export const PUT: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const body = await readJson<Record<string, unknown>>(ctx.request);
  if (!body) return json({ error: 'invalid body' }, 400);

  const patch: Partial<GroupUpdate> = {};
  for (const key of ALLOWED) {
    if (key in body) (patch as Record<string, unknown>)[key] = body[key];
  }
  if (!Object.keys(patch).length) return json({ error: 'no updatable fields' }, 400);

  await updateGroup(env.DB, id, patch);
  return json({ ok: true });
};

// DELETE /api/admin/pipeline/groups/[id] → soft-reject (preserve raw_images rows)
export const DELETE: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  await updateGroup(env.DB, id, { status: 'rejected' });
  return json({ ok: true });
};
