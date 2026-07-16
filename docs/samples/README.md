# Workers AI async batch API — captured ground truth

Raw request/response shapes captured live on 2026-07-16 against account
`5057132d…` via the REST form of the API
(`POST /accounts/{acct}/ai/run/{model}[?queueRequest=true]`). The `env.AI.run`
binding returns the **inner `result` object** of these envelopes — parsing code
should target `result`, not the REST wrapper.

| file | what it is |
| --- | --- |
| `batch-submit-request.json` | Submit body (`{ requests: [...] }`), base64 elided. 2 images, ~17 KB total. |
| `batch-submit-response.queued.json` | Submit ack. Polling while queued returns the identical shape (`status: "queued"`). |
| `batch-poll-complete.scout.json` | **Completed batch, `@cf/meta/llama-4-scout-17b-16e-instruct`.** Key is `responses`; items are `{ id, result: { response }, success, external_reference }`. NOTE: items arrived **out of submit order** (id 1 before id 0) — positional mapping alone would misattribute captions. No top-level `status` field on completion. |
| `batch-poll-complete.kimi-k2.6.json` | Completed batch, `@cf/moonshotai/kimi-k2.6`. Key is `results` (not `responses`); items are `{ index, result: { choices: [{ message: { content, reasoning_content } }] }, success }`. |
| `batch-poll-expired.5504.json` | Poll of an expired/GC'd job. HTTP 4xx envelope; the binding surfaces it as a thrown `AiError: Request not found in queue (…)` (code 5504). |
| `sync-run-response.scout.json` | Same message shape run synchronously (no `queueRequest`) — proves data-URL `image_url` content is accepted; response is `result.response` (string, fenced JSON). |
| `embed-response.embeddinggemma.json` | `@cf/google/embeddinggemma-300m` response: `{ data: [[…768 floats]], shape: [1, 768] }`. |

Observed timing/behavior (2026-07-16):

- scout batch (2 tiny images): completed in ~22 min. kimi-k2.6 batch: ~10 min.
- Results remain pollable after completion (re-polled successfully).
- A 14.8 MB submit (docs limit: 10 MB) was accepted, queued, and — surprisingly
  — completed ~40 min later on kimi-k2.6. So moderate overshoot is tolerated;
  the 47 MB group-3 batch that sat `queued` for a week (then expired with 5504)
  either crossed a harder undocumented threshold or hit scout-queue flakiness.
  Chunking to the documented cap avoids the whole question.
- `@cf/moonshotai/kimi-k2-instruct` no longer exists in the model catalog
  (replaced by `kimi-k2.6` / `kimi-k2.7-code`).
