# Pipeline batch-flow: verification results (2026-07-16)

The autonomous verification plan that used to live in this file has been
executed. This file now records what was actually wrong and what was verified,
so the next session doesn't re-derive it. Captured API ground truth lives in
`docs/samples/` (see its README).

## Root causes found (in order of severity)

1. **Every production reconcile has been dead on arrival.** The KV lock in
   `reconcileWithLock` used `expirationTtl: 30`; Workers KV rejects TTLs < 60
   with a 400, so the lock `put` threw and the route returned `{error}` without
   polling a single batch. This is why the group-3 batch row stayed
   `submitted`/retry 0 even after the PR #5/#6 fixes deployed, and why the
   symptom survived those fixes. Fixed: TTL 60, and the lock is now
   best-effort — KV failure can no longer block reconciliation.
2. **Scout batch items can carry `result.response` as an already-parsed JSON
   object** (the same completed batch mixed object items and fenced-string
   items). `extractContent` → `extractJsonObject` then threw
   `text.indexOf is not a function`, wedging the batch in a retry loop. Fixed:
   `safeParseVlm` accepts both shapes.
3. **`@cf/moonshotai/kimi-k2-instruct` no longer exists** in the model catalog
   — interview drafting and synthesis would have hard-failed the moment a batch
   completed. Fixed: `TEXT_MODEL = '@cf/moonshotai/kimi-k2.6'` (verified live:
   sync chat, interview questions, and full synthesis all work).
4. **Oversized submissions enter a black hole.** The batch API accepts
   payloads over its documented 10 MB cap and (at 47 MB, the real group-3
   submission) never processes them; the job eventually expires (5504). A
   14.8 MB test batch did complete, so the hard threshold is somewhere above
   that — chunking to the documented cap sidesteps the question. Fixed:
   images are downscaled via the new `IMAGES` binding (width 1200, JPEG q80)
   before submit, and `chunkVlmItems` splits a group into ≤8 MB submissions
   (one `pipeline_batches` row per chunk; UI polls them all).

## Confirmed correct (previously "fixed blind", now verified against reality)

- Completion detection by results-array-present (PR #5): right call — completed
  batches return NO top-level `status` field (see samples).
- Terminal handling of expired jobs (PR #6): the binding throws
  `AiError: Request not found in queue (…)` / 5504; reconcile marks the batch
  failed and reverts its images to `culled`.
- Positional mapping by item `id` (scout): REQUIRED, not defensive — completed
  scout batches return items out of submit order (observed twice: 1,0 and
  0,2,1). kimi-style `index` fields are now also honored.
- Submit ack shape: `{ status: "queued", request_id, model }` —
  `submitVlmBatch` reads `request_id` correctly.
- `@cf/meta/llama-4-scout-17b-16e-instruct` exists, supports `async_queue`,
  accepts data-URL `image_url` content. Tiny batches completed in ~10–25 min.
- `@cf/google/embeddinggemma-300m`: 768-dim, `{ data: [[…]] }` — matches
  `embedCaption` and the Vectorize index config.
- AI Gateway (`ai-coder`) + `queueRequest: true` coexist fine (risk 4 cleared).

## E2E verified in the local rig (2026-07-16)

Synthetic EXIF photos → local R2/D1 → `astro dev` (remote AI proxy via wrangler
OAuth): cull → submit-batch (downscale + chunk, live queue) → reconcile →
correct per-image captions → embeddings (Vectorize is remote-only; upsert warns
locally, non-fatal) → interview questions (live kimi-k2.6) → synthesis →
publish (hidden project row created, group `published`; the Cloudflare Images
upload itself needs the `CF_IMAGES_TOKEN` secret and fails per-image with a
warning without it, by design).

`npm test` (vitest) pins all captured shapes and the reconcile state machine;
CI runs it before build.

## Captioning transport: sync-first (2026-07-16, second pass)

The async batch queue has no latency guarantee — tiny jobs sat 10–25 min in
`queued`. The same image captions in ~3–5 s with a plain `env.AI.run`. So the
default path is now **synchronous**:

- `submit-batch` no longer calls the queue. It inserts a `vlm_sync` batch row
  (`cf_batch_id = NULL`), marks the images `vlm_pending`, kicks one reconcile
  via `waitUntil`, and returns immediately. Pressing it again is safe: it 400s
  ("no culled images") or 409s ("captioning already in progress").
- Each reconcile tick captions up to `SYNC_CAPTIONS_PER_TICK` (4) pending
  images with `captionImageSync`, flipping them `vlm_pending → vlm_done`, and
  completes the batch when none remain. The admin UI polls every ~2.5 s and
  repaints the grid, so per-image status updates live (amber pulse → green).
- Fallback: if sync calls keep failing (capacity), after `MAX_RETRIES` the
  batch is handed to the async queue (`resubmitBatch` sets `cf_batch_id`), and
  from then on it polls like any queued batch. The queue path, its parsing, and
  all the samples in `docs/samples/` are still live for that fallback.

Local-dev gotcha: `astro dev` establishes the AI remote-proxy session at boot;
after a few idle hours it expires and every AI call fails fast with
`error code: 1031`. Restart the dev server to refresh it — this is a
wrangler-remote-bindings artifact, not a production issue (the binding is
native in prod).

## Still open / operational notes

- Reconcile only runs when an admin page is open (`waitUntil` on list routes or
  the button). With sync captioning a group now finishes in a handful of ticks
  (~4 images each), so captions appear within a minute of opening the page
  rather than after a multi-minute queue; a cron trigger would remove even that
  dependency but the Astro adapter owns the worker entry (fetch-only).
- Production group 3 was cleaned up (batch → `failed`, its 16 images →
  `culled`) so it can be re-submitted from the UI after this deploys. No
  captions were fabricated.
- `scripts/upload-archive.ts` still uploads originals; only the VLM submission
  path downscales.
