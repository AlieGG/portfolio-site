// Unit tests for the VLM batch parsing layer, pinned against REAL captured
// responses from the Workers AI async batch API (docs/samples/, captured
// 2026-07-16). If these shapes churn, re-capture before "fixing" the tests.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pollVlmBatch,
  extractContent,
  safeParseVlm,
  chunkVlmItems,
  submitVlmBatch,
  MAX_BATCH_PAYLOAD_BYTES,
  VISION_MODEL,
  type VlmBatchItem,
} from '../src/lib/ai-pipeline';

const sample = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'samples', name), 'utf8'));

// The env.AI.run binding returns the inner `result` of the REST envelope.
const bindingResult = (name: string) => sample(name).result;

function envWithAiResult(result: unknown): Env {
  return {
    AI: { run: async () => result },
    AI_GATEWAY_ID: '',
  } as unknown as Env;
}

function envWithAiError(message: string): Env {
  return {
    AI: {
      run: async () => {
        throw new Error(message);
      },
    },
    AI_GATEWAY_ID: '',
  } as unknown as Env;
}

/* ------------------------------ pollVlmBatch ------------------------------ */

describe('pollVlmBatch against captured shapes', () => {
  it('parses a completed llama-scout batch (out-of-order ids)', async () => {
    // Real shape: { responses: [{ id: 1, ... }, { id: 0, ... }], usage } —
    // note id 1 arrives FIRST. imageIds[0]=101, imageIds[1]=202.
    const env = envWithAiResult(bindingResult('batch-poll-complete.scout.json'));
    const r = await pollVlmBatch(env, 'req-1', [101, 202]);
    expect(r.status).toBe('complete');
    expect(r.results).toHaveLength(2);
    // id:1 (first array item) must map to imageIds[1] = 202, not positionally to 101.
    const first = r.results!.find((x) => x.id === 202)!;
    expect(first.caption).toMatch(/LED/i);
    const second = r.results!.find((x) => x.id === 101)!;
    expect(second.caption).toMatch(/circuit board/i);
    for (const res of r.results!) {
      expect(res.quality_score).toBeGreaterThan(0);
      expect(res.quality_score).toBeLessThanOrEqual(1);
      expect(res.candidate_tags.length).toBeGreaterThan(0);
      expect(res.candidate_tags.length).toBeLessThanOrEqual(5);
    }
  });

  it('parses a scout batch whose response field is an already-parsed OBJECT', async () => {
    // Real shape captured in local dev: the same completed batch mixed
    // `result.response` as a parsed JSON object (items 0, 1) and as a fenced
    // string (item 2). The object variant used to throw text.indexOf-is-not-a-
    // function and wedge the batch in a retry loop.
    const env = envWithAiResult(bindingResult('batch-poll-complete.scout.object-response.json'));
    const r = await pollVlmBatch(env, 'req-1', [11, 22, 33]);
    expect(r.status).toBe('complete');
    expect(r.results).toHaveLength(3);
    // out-of-order again (0, 2, 1) — id-based mapping
    expect(r.results!.find((x) => x.id === 11)!.caption).toMatch(/PCB/i);
    expect(r.results!.find((x) => x.id === 22)!.caption).toMatch(/WIRING/i);
    expect(r.results!.find((x) => x.id === 33)!.caption).toMatch(/LED/i);
  });

  it('parses a completed kimi-k2.6 batch (results/index/choices shape)', async () => {
    const env = envWithAiResult(bindingResult('batch-poll-complete.kimi-k2.6.json'));
    const r = await pollVlmBatch(env, 'req-1', [11, 22]);
    expect(r.status).toBe('complete');
    // kimi content here is prose, not the VLM JSON contract, so results may be
    // empty — the point is: completion is detected and nothing throws.
    expect(r.results).toBeDefined();
  });

  it('reports a queued batch as processing', async () => {
    const env = envWithAiResult(bindingResult('batch-submit-response.queued.json'));
    const r = await pollVlmBatch(env, 'req-1', [1, 2]);
    expect(r.status).toBe('processing');
  });

  it('treats a thrown 5504 (expired job) as failed with the message preserved', async () => {
    const env = envWithAiError('AiError: AiError: Request not found in queue (0d792448)');
    const r = await pollVlmBatch(env, 'req-1', [1, 2]);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/not found in queue/i);
  });

  it('does not complete on a missing status field with no results array', async () => {
    const env = envWithAiResult({ request_id: 'x', model: VISION_MODEL });
    const r = await pollVlmBatch(env, 'req-1', [1]);
    expect(r.status).toBe('processing');
  });

  it('fails on an explicit error status', async () => {
    const env = envWithAiResult({ status: 'error', errors: [{ message: 'boom' }] });
    const r = await pollVlmBatch(env, 'req-1', [1]);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/boom/);
  });

  it('skips per-item failures without losing the rest', async () => {
    const scout = bindingResult('batch-poll-complete.scout.json');
    const doctored = {
      ...scout,
      responses: [
        { ...scout.responses[0], success: false },
        scout.responses[1],
      ],
    };
    const env = envWithAiResult(doctored);
    const r = await pollVlmBatch(env, 'req-1', [101, 202]);
    expect(r.status).toBe('complete');
    expect(r.results).toHaveLength(1);
    expect(r.results![0].id).toBe(101); // the surviving item was id:0
  });

  it('maps kimi-style index fields when id is absent', async () => {
    const env = envWithAiResult({
      results: [
        {
          index: 1,
          success: true,
          result: { choices: [{ message: { content: '{"caption":"b","quality_score":0.5,"candidate_tags":["x"]}' } }] },
        },
        {
          index: 0,
          success: true,
          result: { choices: [{ message: { content: '{"caption":"a","quality_score":0.5,"candidate_tags":["y"]}' } }] },
        },
      ],
    });
    const r = await pollVlmBatch(env, 'req-1', [11, 22]);
    expect(r.status).toBe('complete');
    expect(r.results!.find((x) => x.id === 22)!.caption).toBe('b');
    expect(r.results!.find((x) => x.id === 11)!.caption).toBe('a');
  });

  it('handles an empty responses array as still processing', async () => {
    const env = envWithAiResult({ responses: [] });
    const r = await pollVlmBatch(env, 'req-1', [1]);
    expect(r.status).toBe('processing');
  });
});

/* ----------------------------- submitVlmBatch ----------------------------- */

describe('submitVlmBatch', () => {
  it('returns the request_id from the real queued ack shape', async () => {
    const ack = bindingResult('batch-submit-response.queued.json');
    let captured: any;
    const env = {
      AI: {
        run: async (_m: string, input: any) => {
          captured = input;
          return ack;
        },
      },
      AI_GATEWAY_ID: '',
    } as unknown as Env;
    const items: VlmBatchItem[] = [{ id: 7, dataUrl: 'data:image/jpeg;base64,AAAA' }];
    const reqId = await submitVlmBatch(env, items);
    expect(reqId).toBe(ack.request_id);
    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0].messages[0].content[0].image_url.url).toContain('base64');
  });

  it('throws when no request id is present', async () => {
    const env = envWithAiResult({ status: 'queued' });
    await expect(submitVlmBatch(env, [{ id: 1, dataUrl: 'x' }])).rejects.toThrow(/request_id/);
  });
});

/* ---------------------------- content extraction --------------------------- */

describe('extractContent', () => {
  it('reads scout batch items (result.response)', () => {
    const item = bindingResult('batch-poll-complete.scout.json').responses[0];
    expect(extractContent(item)).toMatch(/caption/);
  });

  it('reads kimi batch items (result.choices[0].message.content)', () => {
    const item = bindingResult('batch-poll-complete.kimi-k2.6.json').results[0];
    expect(extractContent(item).length).toBeGreaterThan(0);
  });

  it('reads a sync run response (response at top level after envelope strip)', () => {
    const res = bindingResult('sync-run-response.scout.json');
    expect(extractContent(res)).toMatch(/caption/);
  });

  it('returns empty string for junk', () => {
    expect(extractContent(null)).toBe('');
    expect(extractContent({})).toBe('');
  });
});

/* ------------------------------- safeParseVlm ------------------------------ */

describe('safeParseVlm', () => {
  it('parses the real fenced VLM output from scout', () => {
    const content = extractContent(bindingResult('batch-poll-complete.scout.json').responses[0]);
    const parsed = safeParseVlm(content)!;
    expect(parsed.caption.length).toBeGreaterThan(10);
    expect(parsed.quality_score).toBeCloseTo(0.8);
    expect(parsed.candidate_tags).toContain('pcb');
    expect(parsed.subject_type).toBe('pcb');
  });

  it('clamps out-of-range quality scores', () => {
    expect(safeParseVlm('{"caption":"x","quality_score":7,"candidate_tags":[]}')!.quality_score).toBe(1);
    expect(safeParseVlm('{"caption":"x","quality_score":-2,"candidate_tags":[]}')!.quality_score).toBe(0);
    expect(safeParseVlm('{"caption":"x","quality_score":"junk","candidate_tags":[]}')!.quality_score).toBe(0);
  });

  it('caps tags at 5 and drops non-strings', () => {
    const parsed = safeParseVlm(
      '{"caption":"x","quality_score":0.5,"candidate_tags":["a","b",3,"c","d","e","f"]}'
    )!;
    expect(parsed.candidate_tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('rejects prose with no JSON object', () => {
    expect(safeParseVlm('I could not analyze this image.')).toBeNull();
    expect(safeParseVlm('')).toBeNull();
  });
});

/* ------------------------------ chunkVlmItems ------------------------------ */

describe('chunkVlmItems', () => {
  const item = (id: number, bytes: number): VlmBatchItem => ({
    id,
    dataUrl: 'x'.repeat(bytes),
  });

  it('keeps a small group in one chunk', () => {
    const chunks = chunkVlmItems([item(1, 300_000), item(2, 300_000), item(3, 300_000)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('splits when the payload would exceed the cap', () => {
    // 16 x 3 MB ≈ the real group-3 failure mode.
    const items = Array.from({ length: 16 }, (_, i) => item(i + 1, 3_000_000));
    const chunks = chunkVlmItems(items);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const size = c.reduce((s, it) => s + it.dataUrl.length, 0);
      expect(size).toBeLessThanOrEqual(MAX_BATCH_PAYLOAD_BYTES);
    }
    // Nothing dropped, order preserved.
    expect(chunks.flat().map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('gives an oversize single item its own chunk instead of dropping it', () => {
    const chunks = chunkVlmItems([item(1, 100), item(2, MAX_BATCH_PAYLOAD_BYTES + 1), item(3, 100)]);
    expect(chunks.flat()).toHaveLength(3);
    expect(chunks.some((c) => c.length === 1 && c[0].id === 2)).toBe(true);
  });

  it('returns no chunks for no items', () => {
    expect(chunkVlmItems([])).toEqual([]);
  });
});
