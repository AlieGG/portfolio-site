// Shared batch reconciliation. Polls in-flight Workers AI batches, writes their
// results back into D1, then advances each finished group (embed captions →
// Vectorize, draft interview questions). Safe to call repeatedly; an already
// 'complete' batch is skipped because listPendingBatches only returns
// submitted/processing rows.
//
// There is no cron (the Astro adapter owns the worker entry and only exposes a
// fetch handler), so this runs on-demand from the /pipeline/reconcile route and
// opportunistically via waitUntil on the list routes.

import {
  listPendingBatches,
  updateBatchStatus,
  incrementBatchRetry,
  updateRawImageVlm,
  setRawImageVectorizeId,
  listRawImagesByGroup,
  getGroup,
  updateGroup,
  revertImagesToCulled,
  type PipelineBatch,
} from './pipeline-db';
import {
  pollVlmBatch,
  embedCaption,
  draftInterviewQuestions,
  submitVlmBatch,
  type VlmBatchItem,
} from './ai-pipeline';
import { r2ObjectToDataUrl } from './r2-pipeline';
import { getRawImage } from './pipeline-db';

const MAX_RETRIES = 3;
const LOCK_KEY = 'reconcile-lock';
const LOCK_TTL = 30; // seconds

export interface ReconcileSummary {
  polled: number;
  completed: number;
  failed: number;
  stillProcessing: number;
  errors?: number;
  skippedLocked?: boolean;
}

// KV-locked wrapper so overlapping requests don't double-poll the same batches.
export async function reconcileWithLock(env: Env): Promise<ReconcileSummary> {
  const held = await env.PIPELINE_KV.get(LOCK_KEY);
  if (held) return { polled: 0, completed: 0, failed: 0, stillProcessing: 0, skippedLocked: true };
  await env.PIPELINE_KV.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL });
  try {
    return await reconcilePendingBatches(env);
  } finally {
    await env.PIPELINE_KV.delete(LOCK_KEY);
  }
}

export async function reconcilePendingBatches(env: Env): Promise<ReconcileSummary> {
  const batches = await listPendingBatches(env.DB);
  const summary: ReconcileSummary = {
    polled: batches.length,
    completed: 0,
    failed: 0,
    stillProcessing: 0,
  };

  for (const batch of batches) {
    // Never let one bad batch 500 the whole reconcile.
    try {
      await reconcileOne(env, batch, summary);
    } catch (e) {
      summary.errors = (summary.errors ?? 0) + 1;
      console.warn(`reconcile: batch ${batch.id} errored: ${(e as Error).message}`);
      try {
        await incrementBatchRetry(env.DB, batch.id, `reconcile error: ${(e as Error).message}`);
      } catch {
        /* best-effort */
      }
    }
  }

  return summary;
}

async function reconcileOne(env: Env, batch: PipelineBatch, summary: ReconcileSummary): Promise<void> {
  if (!batch.cf_batch_id) {
    await updateBatchStatus(env.DB, batch.id, 'failed');
    await revertImagesToCulled(env.DB, batch.image_ids);
    summary.failed++;
    return;
  }

  const result = await pollVlmBatch(env, batch.cf_batch_id, batch.image_ids);

  if (result.status === 'processing') {
    await updateBatchStatus(env.DB, batch.id, 'processing');
    summary.stillProcessing++;
    return;
  }

  if (result.status === 'failed') {
    const err = result.error ?? 'unknown';
    // A "not found in queue" (expired/GC'd) job can never recover by re-polling,
    // and re-submitting from inside reconcile is fragile — treat it (and exhausted
    // retries) as terminal: mark failed and release the images back to 'culled'
    // so they can be re-submitted cleanly from the UI's "Submit to VLM" button.
    const expired = /not found|5504|no such/i.test(err);
    if (expired || batch.retry_count >= MAX_RETRIES) {
      await incrementBatchRetry(env.DB, batch.id, err);
      await updateBatchStatus(env.DB, batch.id, 'failed');
      await revertImagesToCulled(env.DB, batch.image_ids);
      summary.failed++;
      return;
    }
    // Transient failure: bump retry and try a fresh re-submit, but if that throws
    // don't crash — fail the batch and release its images.
    await incrementBatchRetry(env.DB, batch.id, err);
    try {
      await resubmitBatch(env, batch);
      summary.stillProcessing++;
    } catch (e) {
      console.warn(`reconcile: resubmit of ${batch.id} failed: ${(e as Error).message}`);
      await updateBatchStatus(env.DB, batch.id, 'failed');
      await revertImagesToCulled(env.DB, batch.image_ids);
      summary.failed++;
    }
    return;
  }

  // complete
  const done = new Set<number>();
  for (const r of result.results ?? []) {
    await updateRawImageVlm(env.DB, r.id, {
      vlm_caption: r.caption,
      vlm_quality_score: r.quality_score,
      vlm_candidate_tags: r.candidate_tags,
      pipeline_status: 'vlm_done',
    });
    done.add(r.id);
  }
  // Any batch image that came back with no usable result shouldn't stay stuck
  // pending — send it back to 'culled' so it can be re-submitted.
  const stuck = batch.image_ids.filter((id) => !done.has(id));
  if (stuck.length) await revertImagesToCulled(env.DB, stuck);
  await updateBatchStatus(env.DB, batch.id, 'complete');
  summary.completed++;

  if (batch.group_id != null) {
    await queueEmbeddingBatch(env, batch.group_id);
    await draftGroupInterviewQuestions(env, batch.group_id);
  }
}

// Re-submit a failed batch with freshly-read image bytes and a new request id.
async function resubmitBatch(env: Env, batch: PipelineBatch): Promise<void> {
  const items: VlmBatchItem[] = [];
  for (const id of batch.image_ids) {
    const img = await getRawImage(env.DB, id);
    if (!img) continue;
    const dataUrl = await r2ObjectToDataUrl(env, img.r2_key);
    if (dataUrl) items.push({ id, dataUrl });
  }
  if (!items.length) {
    await updateBatchStatus(env.DB, batch.id, 'failed');
    return;
  }
  const cfBatchId = await submitVlmBatch(env, items);
  await updateBatchStatus(env.DB, batch.id, 'submitted', cfBatchId);
}

// Embed every vlm_done caption in a group and upsert into Vectorize.
export async function queueEmbeddingBatch(env: Env, groupId: number): Promise<void> {
  const images = await listRawImagesByGroup(env.DB, groupId);
  const vectors: VectorizeVector[] = [];
  for (const img of images) {
    if (img.pipeline_status !== 'vlm_done' || !img.vlm_caption) continue;
    try {
      const values = await embedCaption(env, img.vlm_caption);
      const vid = `img-${img.id}`;
      vectors.push({ id: vid, values, metadata: { group_id: groupId, raw_image_id: img.id } });
      await setRawImageVectorizeId(env.DB, img.id, vid, 'embedded');
    } catch (e) {
      console.warn(`embed failed for image ${img.id}: ${(e as Error).message}`);
    }
  }
  if (vectors.length) {
    try {
      await env.VECTORIZE.upsert(vectors);
    } catch (e) {
      console.warn(`vectorize upsert failed for group ${groupId}: ${(e as Error).message}`);
    }
  }
}

// Draft interview questions for a group from its captions + tags, save on the group.
export async function draftGroupInterviewQuestions(env: Env, groupId: number): Promise<void> {
  const group = await getGroup(env.DB, groupId);
  if (!group) return;
  // Don't overwrite questions the human may already be answering.
  if (group.interview_questions.length) return;

  const images = await listRawImagesByGroup(env.DB, groupId);
  const captions = images.map((i) => i.vlm_caption).filter((c): c is string => !!c);
  if (!captions.length) return;

  const tagSet = new Set<string>();
  for (const i of images) for (const t of i.vlm_candidate_tags) tagSet.add(t);
  const tags = [...tagSet];

  const questions = await draftInterviewQuestions(env, captions, tags);
  const draftDescription = captions.slice(0, 5).join(' ');
  await updateGroup(env.DB, groupId, {
    interview_questions: questions,
    description_draft: group.description_draft ?? draftDescription,
    tags_draft: group.tags_draft.length ? group.tags_draft : tags.slice(0, 8),
  });
}
