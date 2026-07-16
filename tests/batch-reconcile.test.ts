// Reconcile state-machine tests with the DB/AI/R2 layers mocked out. These pin
// the behaviors that previously broke in production:
//  - an expired job (5504) must terminally fail + release its images
//  - one bad batch must never 500 the whole reconcile
//  - completed results must land per-image, with unmatched images released
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  listPendingBatches: vi.fn(),
  updateBatchStatus: vi.fn(),
  incrementBatchRetry: vi.fn(),
  updateRawImageVlm: vi.fn(),
  setRawImageVectorizeId: vi.fn(),
  listRawImagesByGroup: vi.fn(async () => []),
  getGroup: vi.fn(async () => null),
  updateGroup: vi.fn(),
  revertImagesToCulled: vi.fn(),
  getRawImage: vi.fn(),
}));

const ai = vi.hoisted(() => ({
  pollVlmBatch: vi.fn(),
  captionImageSync: vi.fn(),
  embedCaption: vi.fn(async () => Array(768).fill(0)),
  draftInterviewQuestions: vi.fn(async () => []),
  submitVlmBatch: vi.fn(),
  chunkVlmItems: vi.fn((items: unknown[]) => (items.length ? [items] : [])),
}));

const r2 = vi.hoisted(() => ({
  r2ObjectToVlmDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
}));

vi.mock('../src/lib/pipeline-db', () => db);
vi.mock('../src/lib/ai-pipeline', () => ai);
vi.mock('../src/lib/r2-pipeline', () => r2);

import {
  reconcilePendingBatches,
  reconcileWithLock,
  SYNC_CAPTIONS_PER_TICK,
} from '../src/lib/batch-reconcile';

function makeBatch(over: Partial<any> = {}) {
  return {
    id: 'b-1',
    batch_type: 'vlm_caption',
    cf_batch_id: 'cf-1',
    group_id: null, // keep group advancement out of most tests
    status: 'submitted',
    image_ids: [101, 202],
    retry_count: 0,
    ...over,
  };
}

const env = {
  DB: {},
  PIPELINE_KV: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  (env.PIPELINE_KV.get as any).mockResolvedValue(null);
});

describe('reconcile state machine', () => {
  it('fails and releases a batch with no cf_batch_id', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch({ cf_batch_id: null })]);
    const s = await reconcilePendingBatches(env);
    expect(s.failed).toBe(1);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'failed');
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [101, 202]);
  });

  it('keeps a queued batch in processing', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'processing' });
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'processing');
    expect(db.revertImagesToCulled).not.toHaveBeenCalled();
  });

  it('terminally fails an expired (5504) job and releases its images', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({
      status: 'failed',
      error: 'AiError: AiError: Request not found in queue (cf-1)',
    });
    const s = await reconcilePendingBatches(env);
    expect(s.failed).toBe(1);
    expect(ai.submitVlmBatch).not.toHaveBeenCalled(); // no futile resubmit
    expect(db.incrementBatchRetry).toHaveBeenCalled();
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'failed');
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [101, 202]);
  });

  it('resubmits a transient failure with fresh bytes', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'failed', error: 'capacity blip' });
    db.getRawImage.mockResolvedValue({ id: 101, r2_key: 'raw/x.jpg' });
    ai.submitVlmBatch.mockResolvedValue('cf-2');
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(ai.submitVlmBatch).toHaveBeenCalled();
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'submitted', 'cf-2');
  });

  it('fails cleanly (no crash) when the resubmit itself throws', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'failed', error: 'capacity blip' });
    db.getRawImage.mockResolvedValue({ id: 101, r2_key: 'raw/x.jpg' });
    ai.submitVlmBatch.mockRejectedValue(new Error('submit exploded'));
    const s = await reconcilePendingBatches(env);
    expect(s.failed).toBe(1);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'failed');
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [101, 202]);
  });

  it('terminally fails after retries are exhausted even for transient errors', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch({ retry_count: 3 })]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'failed', error: 'capacity blip' });
    const s = await reconcilePendingBatches(env);
    expect(s.failed).toBe(1);
    expect(ai.submitVlmBatch).not.toHaveBeenCalled();
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [101, 202]);
  });

  it('writes completed results per image and releases unmatched images', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({
      status: 'complete',
      results: [
        { id: 101, caption: 'a pcb', quality_score: 0.8, candidate_tags: ['pcb'] },
        // image 202 got no usable result
      ],
    });
    const s = await reconcilePendingBatches(env);
    expect(s.completed).toBe(1);
    expect(db.updateRawImageVlm).toHaveBeenCalledTimes(1);
    expect(db.updateRawImageVlm).toHaveBeenCalledWith(
      env.DB,
      101,
      expect.objectContaining({ vlm_caption: 'a pcb', pipeline_status: 'vlm_done' })
    );
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [202]);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'complete');
  });

  it('advances the group (embeddings + questions) after completion', async () => {
    db.listPendingBatches.mockResolvedValue([makeBatch({ group_id: 3 })]);
    ai.pollVlmBatch.mockResolvedValue({
      status: 'complete',
      results: [{ id: 101, caption: 'a pcb', quality_score: 0.8, candidate_tags: ['pcb'] }],
    });
    await reconcilePendingBatches(env);
    expect(db.listRawImagesByGroup).toHaveBeenCalledWith(env.DB, 3);
    expect(db.getGroup).toHaveBeenCalledWith(env.DB, 3);
  });

  it('never lets one exploding batch break the others', async () => {
    db.listPendingBatches.mockResolvedValue([
      makeBatch({ id: 'b-bad' }),
      makeBatch({ id: 'b-good' }),
    ]);
    ai.pollVlmBatch
      .mockRejectedValueOnce(new Error('kaboom'))
      .mockResolvedValueOnce({ status: 'processing' });
    const s = await reconcilePendingBatches(env);
    expect(s.errors).toBe(1);
    expect(s.stillProcessing).toBe(1);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-good', 'processing');
  });
});

describe('sync captioning batches (batch_type vlm_sync)', () => {
  const syncBatch = (over: Partial<any> = {}) =>
    makeBatch({ batch_type: 'vlm_sync', cf_batch_id: null, status: 'processing', ...over });

  const pendingImage = (id: number) => ({
    id,
    r2_key: `raw/${id}.jpg`,
    pipeline_status: 'vlm_pending',
  });

  const parsed = { caption: 'a pcb', quality_score: 0.8, candidate_tags: ['pcb'] };

  it('captions every pending image and completes when the batch is small', async () => {
    db.listPendingBatches.mockResolvedValue([syncBatch()]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) => pendingImage(id));
    ai.captionImageSync.mockResolvedValue(parsed);
    const s = await reconcilePendingBatches(env);
    expect(s.completed).toBe(1);
    expect(ai.captionImageSync).toHaveBeenCalledTimes(2);
    expect(db.updateRawImageVlm).toHaveBeenCalledWith(
      env.DB,
      101,
      expect.objectContaining({ vlm_caption: 'a pcb', pipeline_status: 'vlm_done' })
    );
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'complete');
    expect(ai.pollVlmBatch).not.toHaveBeenCalled(); // no queue involved
  });

  it('only advances a per-tick slice of a big batch, staying in processing', async () => {
    const ids = Array.from({ length: SYNC_CAPTIONS_PER_TICK + 3 }, (_, i) => 100 + i);
    db.listPendingBatches.mockResolvedValue([syncBatch({ image_ids: ids })]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) => pendingImage(id));
    ai.captionImageSync.mockResolvedValue(parsed);
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(ai.captionImageSync).toHaveBeenCalledTimes(SYNC_CAPTIONS_PER_TICK);
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'processing');
  });

  it('completes on a later tick once already-captioned images are vlm_done', async () => {
    db.listPendingBatches.mockResolvedValue([syncBatch()]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) =>
      id === 101
        ? { ...pendingImage(id), pipeline_status: 'vlm_done' }
        : pendingImage(id)
    );
    ai.captionImageSync.mockResolvedValue(parsed);
    const s = await reconcilePendingBatches(env);
    expect(s.completed).toBe(1);
    expect(ai.captionImageSync).toHaveBeenCalledTimes(1); // only image 202
  });

  it('releases an image whose caption is unparseable instead of wedging', async () => {
    db.listPendingBatches.mockResolvedValue([syncBatch()]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) => pendingImage(id));
    ai.captionImageSync.mockResolvedValueOnce(null).mockResolvedValueOnce(parsed);
    const s = await reconcilePendingBatches(env);
    expect(s.completed).toBe(1);
    expect(db.revertImagesToCulled).toHaveBeenCalledWith(env.DB, [101]);
    expect(db.updateRawImageVlm).toHaveBeenCalledTimes(1);
  });

  it('bumps retries on AI failure and falls back to the async queue when exhausted', async () => {
    db.listPendingBatches.mockResolvedValue([syncBatch({ retry_count: 2 })]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) => pendingImage(id));
    ai.captionImageSync.mockRejectedValue(new Error('3040: capacity temporarily exceeded'));
    ai.submitVlmBatch.mockResolvedValue('cf-queue-1');
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(db.incrementBatchRetry).toHaveBeenCalled();
    expect(ai.submitVlmBatch).toHaveBeenCalled();
    expect(db.updateBatchStatus).toHaveBeenCalledWith(env.DB, 'b-1', 'submitted', 'cf-queue-1');
    expect(db.revertImagesToCulled).not.toHaveBeenCalled();
  });

  it('retries without queue fallback while retries remain', async () => {
    db.listPendingBatches.mockResolvedValue([syncBatch({ retry_count: 0 })]);
    db.getRawImage.mockImplementation(async (_db: unknown, id: number) => pendingImage(id));
    ai.captionImageSync.mockRejectedValue(new Error('capacity'));
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(ai.submitVlmBatch).not.toHaveBeenCalled();
  });

  it('polls like a queue batch after the fallback set cf_batch_id', async () => {
    db.listPendingBatches.mockResolvedValue([
      syncBatch({ cf_batch_id: 'cf-queue-1', status: 'submitted' }),
    ]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'processing' });
    const s = await reconcilePendingBatches(env);
    expect(s.stillProcessing).toBe(1);
    expect(ai.captionImageSync).not.toHaveBeenCalled();
    expect(ai.pollVlmBatch).toHaveBeenCalledWith(env, 'cf-queue-1', [101, 202]);
  });
});

describe('reconcileWithLock', () => {
  it('skips when the lock is held', async () => {
    (env.PIPELINE_KV.get as any).mockResolvedValue('1');
    const s = await reconcileWithLock(env);
    expect(s.skippedLocked).toBe(true);
    expect(db.listPendingBatches).not.toHaveBeenCalled();
  });

  it('takes and releases the lock around a run', async () => {
    db.listPendingBatches.mockResolvedValue([]);
    await reconcileWithLock(env);
    expect(env.PIPELINE_KV.put).toHaveBeenCalled();
    expect(env.PIPELINE_KV.delete).toHaveBeenCalled();
  });

  it('releases the lock even when reconcile throws', async () => {
    db.listPendingBatches.mockRejectedValue(new Error('db down'));
    await expect(reconcileWithLock(env)).rejects.toThrow('db down');
    expect(env.PIPELINE_KV.delete).toHaveBeenCalled();
  });

  it('uses a KV-legal expirationTtl (minimum 60s)', async () => {
    // Workers KV 400s on expirationTtl < 60; a TTL of 30 silently killed every
    // production reconcile. Pin the minimum.
    db.listPendingBatches.mockResolvedValue([]);
    await reconcileWithLock(env);
    const opts = (env.PIPELINE_KV.put as any).mock.calls[0][2];
    expect(opts.expirationTtl).toBeGreaterThanOrEqual(60);
  });

  it('still reconciles when KV itself is broken', async () => {
    (env.PIPELINE_KV.get as any).mockRejectedValue(new Error('KV down'));
    db.listPendingBatches.mockResolvedValue([makeBatch()]);
    ai.pollVlmBatch.mockResolvedValue({ status: 'processing' });
    const s = await reconcileWithLock(env);
    expect(s.stillProcessing).toBe(1);
  });
});
