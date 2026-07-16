# Pipeline batch-flow: autonomous verification plan

This doc is a self-contained handoff for verifying and fixing the image-pipeline
VLM batch flow end-to-end. If you are a fresh Claude session: work on branch
`claude/portfolio-system-architecture-ry2hd2`, execute this plan autonomously,
and only report back when the entire flow is verified working.

## Current state (as of 2026-07-16)

- The pipeline (upload → group → cull → VLM batch → review/interview → publish)
  is deployed and live. Groups/cull/thumbnails/split all verified working by the
  user against real photos.
- **The VLM batch step has never completed successfully.** History:
  - A batch for group 3 ("Flamingo Pool Party June", images
    4,6,7,8,9,13,14,15,16,18,19,20,21,22,23,24) sat in `vlm_pending` for a week.
  - Root cause 1 (fixed, PR #5): `pollVlmBatch` defaulted a missing `status`
    field to `processing` forever. Now completion is driven by a results array
    being present. **Fixed blind — the real success-response shape has still
    never been observed.**
  - Root cause 2 (fixed, PR #6): reconcile 500'd on the expired job
    (`5504: Request not found in queue`) because auto-resubmit inside the poll
    loop threw unguarded. Expired jobs are now terminal: batch → `failed`,
    images reverted to `culled`.
  - The user STILL reports issues after these fixes (exact symptom unspecified —
    re-verify everything; do not assume the fixes are correct).
- Key unknowns / risks:
  1. The **real request/response shape** of the Workers AI async batch API
     (submit via `env.AI.run(model, { requests }, { queueRequest: true })`,
     poll via `env.AI.run(model, { request_id })`) — never observed. The
     parsing in `src/lib/ai-pipeline.ts` (`submitVlmBatch`, `pollVlmBatch`,
     `extractContent`) is best-effort guesswork.
  2. Whether `@cf/meta/llama-4-scout-17b-16e-instruct` actually supports the
     batch API + the `messages`/`image_url` content shape used. Model IDs may
     have churned; `@cf/moonshotai/kimi-k2-instruct` (TEXT_MODEL) and
     `@cf/google/embeddinggemma-300m` (EMBED_MODEL, must be 768-dim) also
     unverified against the live catalog.
  3. Whether base64 **data-URL images** are accepted by the batch API, and
     whether 16 full-size photos exceed request-size limits (a likely failure
     mode: inlined base64 of multi-MB JPEGs → oversized request). If so,
     consider downscaling before submit or per-image requests.
  4. Whether the `gateway` option (`AI_GATEWAY_ID="ai-coder"`, authenticated
     gateway ON) works with `queueRequest: true`. If it breaks batch mode, drop
     the gateway option for batch calls only.

## Verified facts about the environment

- Local rig WORKS in the sandbox: `npm run db:local && npm run db:seed:local &&
  npm run db:pipeline:local`, then `npx astro dev --port 4321` boots Miniflare
  with local D1/R2/KV; dev-mode middleware grants admin, so all
  `/api/admin/pipeline/*` routes are callable with plain curl.
  Confirmed: `GET /api/admin/pipeline/groups` → `{"groups":[]}`.
- BUT the `ai` + `vectorize` bindings force a **remote proxy session** at boot:
  requires `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) in env AND
  network egress to `api.cloudflare.com`. Without them, `astro dev` fails at
  `startRemoteProxySession` ("You must be logged in…"). Temporarily removing
  those two stanzas from `wrangler.jsonc` is the fallback for AI-less testing.
- Sandbox egress: `api.cloudflare.com` + `gateway.ai.cloudflare.com` were
  BLOCKED by org policy (CONNECT 403); `*.r2.cloudflarestorage.com` reachable.
  The user has been asked to allow them. Re-test before assuming.
- Account id: `5057132d8bf358607b75512371711d57`. D1 db id:
  `2383504b-6493-4c3e-a0d5-48efd47ce000` (`alie_portfolio`). KV
  `PIPELINE_KV` id `55e80abca490464a93327b56edf193c3`. Gateway id `ai-coder`.
- Credentials, when granted, land as env vars `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` (or pasted in chat → write to `.dev.vars`, which is
  gitignored — NEVER commit them). For the publish step, set
  `CF_IMAGES_TOKEN` in `.dev.vars` to the same token if it has Images Edit.

## The plan

1. **Recon (REST, no rig needed):** with the token, hit
   `GET https://api.cloudflare.com/client/v4/accounts/{acct}/ai/models/search`
   to confirm the three model IDs exist and which support async/batch. Fix
   `src/lib/ai-pipeline.ts` constants if churned.
2. **Capture real shapes (REST):** submit a tiny batch (2 small synthetic
   JPEGs, generated in the sandbox) to the async endpoint
   (`.../ai/run/<model>?queueRequest=true` — confirm exact REST form from the
   response itself), poll until complete, and SAVE the raw submit/poll JSON to
   `docs/samples/` (sanitized). This is ground truth.
3. **Unit tests:** add `tests/` with vitest (devDep) covering `pollVlmBatch` /
   `extractContent` / `safeParseVlm` against the captured real shapes + edge
   cases (missing status, error shapes, empty results, positional vs id
   mapping), and the reconcile state machine with a mocked AI + real local D1
   if feasible (else a thin fake). Wire `npm test`.
4. **Fix/refactor** `ai-pipeline.ts` (+ `batch-reconcile.ts` if needed) to
   match reality. Consider: image downscaling before submit (see risk 3),
   dropping gateway on batch calls if incompatible (risk 4).
5. **Full e2e in the rig:** boot `astro dev` with the token; seed local R2 +
   D1 with synthetic EXIF photos (see `scripts/upload-archive.ts` fixtures
   pattern from git history, or generate with PIL/piexif — pip install works);
   drive the whole flow with curl: groups → confirm → cull → submit-batch →
   reconcile (poll until captions land) → interview (live Kimi) → publish
   (live Images upload if CF_IMAGES_TOKEN available, else assert the route up
   to the upload call). Assert D1 rows at each stage.
6. **Ship:** PR → CI → merge → confirm deploy (established pattern; squash,
   base `main`).
7. **Prod cleanup:** via REST D1, check group 3's batch/images state; ensure
   images are `culled` (re-submittable) and no batch is stuck. Do NOT
   fabricate captions.
8. **Report** with what was actually broken, evidence (raw shapes), and test
   results.

## Constraints

- Never commit secrets (`.dev.vars` is gitignored — keep it that way).
- Live AI calls cost pennies; keep test batches small (2–3 tiny images).
- Production data: read freely; write only the cleanup in step 7.
- The user does not want to be engaged until the flow is fully verified.
