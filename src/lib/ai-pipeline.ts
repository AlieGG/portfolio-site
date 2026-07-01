// Workers AI calls for the pipeline, all routed through AI Gateway so a model
// swap is a one-line change here. Model IDs churn fast — re-confirm against
// https://developers.cloudflare.com/workers-ai/models/ at build time.

// ---- Pinned model IDs (verify against the live catalog before deploy) ----
export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const TEXT_MODEL = '@cf/moonshotai/kimi-k2-instruct'; // synthesis
export const EMBED_MODEL = '@cf/google/embeddinggemma-300m'; // text embeddings

// Gateway option applied to every call. AI_GATEWAY_ID may be empty in local dev,
// in which case we omit the gateway and hit Workers AI directly.
function opts(env: Env): { gateway?: { id: string } } {
  return env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {};
}

/* ------------------------------- prompts ------------------------------- */

export const VLM_PROMPT = `You are analyzing a single project photo for a maker/artist portfolio.
Output ONLY valid JSON, no prose, with exactly these keys:
{
  "caption": "<1-2 sentence factual description of what is depicted>",
  "quality_score": <number 0.0-1.0 for technical quality: sharpness, exposure, composition>,
  "candidate_tags": ["<tag>", ...],
  "subject_type": "<pcb|wiring|enclosure|installation|process|detail|other>"
}
candidate_tags: max 5, lowercase, technology/craft terms.`;

/* ------------------------- vision batch (async) ------------------------- */

export interface VlmBatchItem {
  id: number; // raw_image id
  dataUrl: string; // data:image/...;base64,...
}

// One parsed VLM result, mapped back to its raw_image id.
export interface VlmParsed {
  id: number;
  caption: string;
  quality_score: number;
  candidate_tags: string[];
  subject_type?: string;
}

export interface BatchPollResult {
  status: 'processing' | 'complete' | 'failed';
  results?: VlmParsed[];
  error?: string;
}

// Submit an async batch job. Returns the Workers AI request id to poll later.
// The order of `items` is preserved in the response, so callers should persist
// the id ordering (image_ids) to map results back.
export async function submitVlmBatch(env: Env, items: VlmBatchItem[]): Promise<string> {
  const requests = items.map((it) => ({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: it.dataUrl } },
          { type: 'text', text: VLM_PROMPT },
        ],
      },
    ],
  }));

  // queueRequest: true → async batch mode. Response carries a request_id.
  const res: any = await (env.AI as any).run(
    VISION_MODEL,
    { requests },
    { ...opts(env), queueRequest: true }
  );
  const requestId = res?.request_id ?? res?.requestId ?? res?.id;
  if (!requestId) {
    throw new Error(`submitVlmBatch: no request_id in response: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return String(requestId);
}

// Poll a previously-submitted batch. `imageIds` must be the submit-order id list
// so positional responses can be mapped back to raw_image rows.
export async function pollVlmBatch(
  env: Env,
  cfBatchId: string,
  imageIds: number[]
): Promise<BatchPollResult> {
  let res: any;
  try {
    res = await (env.AI as any).run(VISION_MODEL, { request_id: cfBatchId }, opts(env));
  } catch (e) {
    return { status: 'failed', error: (e as Error).message };
  }

  const status: string = res?.status ?? 'processing';
  if (status === 'queued' || status === 'running' || status === 'processing') {
    return { status: 'processing' };
  }
  if (status === 'error' || status === 'failed') {
    return { status: 'failed', error: res?.error ? JSON.stringify(res.error) : 'batch failed' };
  }

  // Complete. Responses come back in submit order.
  const responses: any[] = res?.responses ?? res?.results ?? [];
  const results: VlmParsed[] = [];
  responses.forEach((r, i) => {
    const id = imageIds[i];
    if (id == null) return;
    const content = extractContent(r);
    const parsed = safeParseVlm(content);
    if (parsed) results.push({ id, ...parsed });
  });
  return { status: 'complete', results };
}

// Pull the text content out of one batch response item (shape varies by model).
function extractContent(r: any): string {
  return (
    r?.result?.response ??
    r?.response ??
    r?.result?.choices?.[0]?.message?.content ??
    r?.choices?.[0]?.message?.content ??
    (typeof r === 'string' ? r : '') ??
    ''
  );
}

function safeParseVlm(content: string): Omit<VlmParsed, 'id'> | null {
  if (!content) return null;
  const json = extractJsonObject(content);
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    return {
      caption: typeof o.caption === 'string' ? o.caption : '',
      quality_score: clamp01(Number(o.quality_score)),
      candidate_tags: Array.isArray(o.candidate_tags)
        ? o.candidate_tags.filter((t: unknown) => typeof t === 'string').slice(0, 5)
        : [],
      subject_type: typeof o.subject_type === 'string' ? o.subject_type : undefined,
    };
  } catch {
    return null;
  }
}

/* ------------------------------ embeddings ------------------------------ */

export async function embedCaption(env: Env, caption: string): Promise<number[]> {
  const res: any = await (env.AI as any).run(EMBED_MODEL, { text: caption }, opts(env));
  // EmbeddingGemma returns { data: [[...]] } (or { data: { embeddings } }).
  const vec = res?.data?.[0] ?? res?.data?.embeddings?.[0] ?? res?.embeddings?.[0];
  if (!Array.isArray(vec)) {
    throw new Error(`embedCaption: unexpected shape ${JSON.stringify(res).slice(0, 200)}`);
  }
  return vec as number[];
}

/* --------------------------- text synthesis --------------------------- */

export interface KimiSynthesisInput {
  draft: string;
  qa: { question: string; answer: string }[];
  tags: string[];
}

export interface KimiOutput {
  description: string;
  tags: string[];
}

export async function synthesizeWithKimi(env: Env, input: KimiSynthesisInput): Promise<KimiOutput> {
  const qaText = input.qa.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join('\n');
  const prompt = `You are writing portfolio copy for a maker/artist. Given:
- Draft observations from image analysis: ${input.draft || '(none)'}
- Interview answers:\n${qaText || '(none)'}
- Candidate tags: ${input.tags.join(', ') || '(none)'}

Write a 2-3 sentence portfolio description (first-person, present tense, specific and technical).
Then output ONLY a JSON block on its own: { "description": "...", "tags": ["TAG1", "TAG2"] }
Max 5 tags, ALL CAPS, 1-3 words each.`;

  const res: any = await (env.AI as any).run(
    TEXT_MODEL,
    { messages: [{ role: 'user', content: prompt }] },
    opts(env)
  );
  const content = extractContent(res);
  const json = extractJsonObject(content);
  if (json) {
    try {
      const o = JSON.parse(json);
      if (typeof o.description === 'string') {
        return {
          description: o.description,
          tags: Array.isArray(o.tags)
            ? o.tags.filter((t: unknown) => typeof t === 'string').map((t: string) => t.toUpperCase()).slice(0, 5)
            : input.tags.map((t) => t.toUpperCase()).slice(0, 5),
        };
      }
    } catch {
      /* fall through */
    }
  }
  // Fallback: use the raw text as the description, keep candidate tags.
  return {
    description: content.trim() || input.draft,
    tags: input.tags.map((t) => t.toUpperCase()).slice(0, 5),
  };
}

// Draft 2-3 targeted interview questions from what the model saw.
export async function draftInterviewQuestions(
  env: Env,
  captions: string[],
  tags: string[]
): Promise<string[]> {
  const prompt = `These captions describe photos from one project:
${captions.slice(0, 30).map((c) => `- ${c}`).join('\n')}

Candidate tags: ${tags.join(', ') || '(none)'}

Ask 2-3 short, specific questions whose answers would let you write an accurate portfolio
description (e.g. about the hardware used, scale, event/context, or the technique).
Output ONLY a JSON array of question strings, e.g. ["...", "..."].`;

  const res: any = await (env.AI as any).run(
    TEXT_MODEL,
    { messages: [{ role: 'user', content: prompt }] },
    opts(env)
  );
  const content = extractContent(res);
  const arr = extractJsonArray(content);
  if (arr) {
    try {
      const parsed = JSON.parse(arr);
      if (Array.isArray(parsed)) {
        return parsed.filter((q: unknown) => typeof q === 'string').slice(0, 3);
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

/* ------------------------------- helpers ------------------------------- */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Pull the first {...} block out of a possibly-chatty model response.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
