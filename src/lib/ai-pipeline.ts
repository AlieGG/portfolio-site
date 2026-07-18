// Workers AI calls for the pipeline, all routed through AI Gateway so a model
// swap is a one-line change here. Model IDs churn fast — re-confirm against
// https://developers.cloudflare.com/workers-ai/models/ at build time.

// ---- Pinned model IDs (verify against the live catalog before deploy) ----
// Last verified against the live catalog: 2026-07-16 (see docs/samples/).
export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct'; // async_queue: true
export const TEXT_MODEL = '@cf/moonshotai/kimi-k2.6'; // synthesis (kimi-k2-instruct was retired)
export const EMBED_MODEL = '@cf/google/embeddinggemma-300m'; // text embeddings, 768-dim

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

// The docs cap an async batch submission at 10 MB total payload, but the API
// ACCEPTS oversized submissions and then never processes them (observed: a
// 47 MB batch sat "queued" for a week, then expired with error 5504). Chunk
// well under the cap so a submission can never enter that black hole.
export const MAX_BATCH_PAYLOAD_BYTES = 8_000_000;
// JSON scaffolding per request: messages/content wrapper + the VLM prompt.
const PER_ITEM_OVERHEAD_BYTES = VLM_PROMPT.length + 400;

// Split items into chunks whose serialized payload stays under the size cap.
// An item too large even alone still gets its own chunk — the submit call will
// surface the API's own error rather than us silently dropping the image.
export function chunkVlmItems(items: VlmBatchItem[]): VlmBatchItem[][] {
  const chunks: VlmBatchItem[][] = [];
  let current: VlmBatchItem[] = [];
  let size = 0;
  for (const it of items) {
    const itemSize = it.dataUrl.length + PER_ITEM_OVERHEAD_BYTES;
    if (current.length && size + itemSize > MAX_BATCH_PAYLOAD_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(it);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
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

// Caption ONE image with a plain synchronous call (~3-5 s). This is the
// primary path: the async queue has no latency guarantee and was observed
// sitting 10-25 minutes on tiny jobs. The queue remains the fallback when
// sync calls keep failing (capacity errors) — see batch-reconcile.
export async function captionImageSync(
  env: Env,
  dataUrl: string
): Promise<Omit<VlmParsed, 'id'> | null> {
  const res: any = await (env.AI as any).run(
    VISION_MODEL,
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: VLM_PROMPT },
          ],
        },
      ],
    },
    opts(env)
  );
  return safeParseVlm(extractContent(res));
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

  // Explicit error states first.
  const status: string | undefined = typeof res?.status === 'string' ? res.status : undefined;
  if (status === 'error' || status === 'failed') {
    const err = res?.errors ?? res?.error ?? 'batch failed';
    return { status: 'failed', error: typeof err === 'string' ? err : JSON.stringify(err) };
  }

  // Completion is signalled by a results array being PRESENT — do not rely on a
  // status string: a completed batch returns the array with NO status field
  // (confirmed live, see docs/samples/batch-poll-complete.*.json; that mismatch
  // is what left batches stuck "processing" forever).
  // llama-scout uses `responses` with an `id` position; kimi uses `results`
  // with an `index` position.
  const responses: any[] | undefined =
    (Array.isArray(res?.responses) && res.responses) ||
    (Array.isArray(res?.results) && res.results) ||
    (Array.isArray(res?.result?.responses) && res.result.responses) ||
    (Array.isArray(res) ? res : undefined) ||
    undefined;

  if (responses && responses.length) {
    const results: VlmParsed[] = [];
    responses.forEach((r, i) => {
      // Skip items the API itself marked failed; their images get released by
      // the reconcile "no usable result" sweep.
      if (r?.success === false) return;
      // Map back to the raw_image id via the item's declared position. This is
      // NOT cosmetic: completed scout batches return items OUT of submit order
      // (observed live), so array order alone would misattribute captions.
      const pos =
        typeof r?.id === 'number' && r.id >= 0 && r.id < imageIds.length
          ? r.id
          : typeof r?.index === 'number' && r.index >= 0 && r.index < imageIds.length
            ? r.index
            : i;
      const imageId = imageIds[pos];
      if (imageId == null) return;
      const content = extractContent(r);
      const parsed = safeParseVlm(content);
      if (parsed) results.push({ id: imageId, ...parsed });
    });
    return { status: 'complete', results };
  }

  // Otherwise still queued/running (or an in-progress shape we don't recognize).
  return { status: 'processing' };
}

// Diagnostic: return the untouched poll response so the exact shape can be
// inspected from an admin route without guessing.
export async function rawPollBatch(env: Env, cfBatchId: string): Promise<unknown> {
  try {
    return await (env.AI as any).run(VISION_MODEL, { request_id: cfBatchId }, opts(env));
  } catch (e) {
    return { _pollError: (e as Error).message };
  }
}

// Pull the content out of one batch response item (shape varies by model).
// NOT always a string: scout's batch responses sometimes carry the VLM JSON as
// an already-parsed object in `result.response` (observed live — the same
// batch mixed object and fenced-string items).
export function extractContent(r: any): string | object {
  return (
    r?.result?.response ??
    r?.response ??
    r?.result?.choices?.[0]?.message?.content ??
    r?.choices?.[0]?.message?.content ??
    (typeof r === 'string' ? r : '') ??
    ''
  );
}

export function safeParseVlm(content: string | object): Omit<VlmParsed, 'id'> | null {
  if (!content) return null;
  let o: any;
  if (typeof content === 'object') {
    o = content;
  } else {
    const json = extractJsonObject(content);
    if (!json) return null;
    try {
      o = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (typeof o !== 'object' || o === null || typeof o.caption !== 'string') return null;
  return {
    caption: o.caption,
    quality_score: clamp01(Number(o.quality_score)),
    candidate_tags: Array.isArray(o.candidate_tags)
      ? o.candidate_tags.filter((t: unknown) => typeof t === 'string').slice(0, 5)
      : [],
    subject_type: typeof o.subject_type === 'string' ? o.subject_type : undefined,
  };
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
  const raw = extractContent(res);
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
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
  const raw = extractContent(res);
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
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
