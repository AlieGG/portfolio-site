import type { APIRoute } from 'astro';
import { json, requireAdmin, readJson, parseId } from '../../../../../../lib/api';
import { getGroup, updateGroup } from '../../../../../../lib/pipeline-db';
import { synthesizeWithKimi } from '../../../../../../lib/ai-pipeline';

export const prerender = false;

// GET → questions + any saved answers + the draft description
export const GET: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const group = await getGroup(env.DB, id);
  if (!group) return json({ error: 'not found' }, 404);
  return json({
    questions: group.interview_questions,
    answers: group.interview_answers,
    description_draft: group.description_draft ?? '',
  });
};

// POST { answers: string[] } → save answers, synthesize with Kimi, save finals
export const POST: APIRoute = async (ctx) => {
  const env = requireAdmin(ctx);
  if (env instanceof Response) return env;
  const id = parseId(ctx.params);
  if (!id) return json({ error: 'bad id' }, 400);

  const body = await readJson<{ answers?: unknown }>(ctx.request);
  const answers = Array.isArray(body?.answers)
    ? body!.answers.map((a) => (typeof a === 'string' ? a : ''))
    : [];

  const group = await getGroup(env.DB, id);
  if (!group) return json({ error: 'not found' }, 404);

  await updateGroup(env.DB, id, { interview_answers: answers });

  const qa = group.interview_questions.map((question, i) => ({
    question,
    answer: answers[i] ?? '',
  }));

  let result;
  try {
    result = await synthesizeWithKimi(env, {
      draft: group.description_draft ?? '',
      qa,
      tags: group.tags_draft,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  await updateGroup(env.DB, id, {
    description_final: result.description,
    tags_final: result.tags,
  });

  return json({ description: result.description, tags: result.tags });
};
