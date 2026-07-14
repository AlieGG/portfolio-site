// D1 access layer for the image pipeline (raw_images, pipeline_groups,
// pipeline_batches). Mirrors the style of src/lib/db.ts: parameterized queries,
// explicit column lists, JSON arrays stored as text.

/* ----------------------------- types ----------------------------- */

export interface RawImage {
  id: number;
  r2_key: string;
  original_filename: string;
  capture_ts: string | null;
  date_source: string | null;
  phash: string | null;
  width: number | null;
  height: number | null;
  file_size_bytes: number | null;
  blur_score: number | null;
  exposure_score: number | null;
  vlm_caption: string | null;
  vlm_quality_score: number | null;
  vlm_candidate_tags: string[]; // parsed from JSON
  vectorize_id: string | null;
  group_id: number | null;
  is_hero: number; // 0 | 1
  pipeline_status: string;
  batch_id: string | null;
  created_at: string;
}

export interface RawImageInsert {
  r2_key: string;
  original_filename: string;
  capture_ts?: string | null;
  date_source?: string | null;
  phash?: string | null;
  width?: number | null;
  height?: number | null;
  file_size_bytes?: number | null;
  group_id?: number | null;
}

export interface VlmResult {
  vlm_caption: string;
  vlm_quality_score: number;
  vlm_candidate_tags: string[]; // will be JSON-stringified
  pipeline_status?: string; // defaults to 'vlm_done'
}

export interface PipelineGroup {
  id: number;
  title: string | null;
  proposed_date_range: string | null;
  capture_ts_min: string | null;
  capture_ts_max: string | null;
  status: string;
  description_draft: string | null;
  description_final: string | null;
  tags_draft: string[];
  tags_final: string[];
  interview_questions: string[];
  interview_answers: string[];
  project_id: number | null;
  created_at: string;
}

export interface GroupInsert {
  title?: string | null;
  proposed_date_range?: string | null;
  capture_ts_min?: string | null;
  capture_ts_max?: string | null;
  status?: string;
}

export interface GroupUpdate {
  title: string | null;
  status: string;
  description_draft: string | null;
  description_final: string | null;
  tags_draft: string[] | null;
  tags_final: string[] | null;
  interview_questions: string[] | null;
  interview_answers: string[] | null;
  project_id: number | null;
}

export interface PipelineBatch {
  id: string;
  batch_type: string;
  cf_batch_id: string | null;
  group_id: number | null;
  status: string;
  image_ids: number[]; // parsed from JSON
  retry_count: number;
  error_msg: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface BatchInsert {
  id: string;
  batch_type: string;
  cf_batch_id?: string | null;
  group_id?: number | null;
  status?: string;
  image_ids: number[];
}

type Row = Record<string, unknown>;

/* ---------------------------- parsing ---------------------------- */

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseIdArray(v: unknown): number[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function rowToRawImage(r: Row): RawImage {
  return {
    id: r.id as number,
    r2_key: r.r2_key as string,
    original_filename: r.original_filename as string,
    capture_ts: (r.capture_ts as string) ?? null,
    date_source: (r.date_source as string) ?? null,
    phash: (r.phash as string) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    file_size_bytes: (r.file_size_bytes as number) ?? null,
    blur_score: (r.blur_score as number) ?? null,
    exposure_score: (r.exposure_score as number) ?? null,
    vlm_caption: (r.vlm_caption as string) ?? null,
    vlm_quality_score: (r.vlm_quality_score as number) ?? null,
    vlm_candidate_tags: parseJsonArray(r.vlm_candidate_tags),
    vectorize_id: (r.vectorize_id as string) ?? null,
    group_id: (r.group_id as number) ?? null,
    is_hero: (r.is_hero as number) ?? 0,
    pipeline_status: r.pipeline_status as string,
    batch_id: (r.batch_id as string) ?? null,
    created_at: r.created_at as string,
  };
}

function rowToGroup(r: Row): PipelineGroup {
  return {
    id: r.id as number,
    title: (r.title as string) ?? null,
    proposed_date_range: (r.proposed_date_range as string) ?? null,
    capture_ts_min: (r.capture_ts_min as string) ?? null,
    capture_ts_max: (r.capture_ts_max as string) ?? null,
    status: r.status as string,
    description_draft: (r.description_draft as string) ?? null,
    description_final: (r.description_final as string) ?? null,
    tags_draft: parseJsonArray(r.tags_draft),
    tags_final: parseJsonArray(r.tags_final),
    interview_questions: parseJsonArray(r.interview_questions),
    interview_answers: parseJsonArray(r.interview_answers),
    project_id: (r.project_id as number) ?? null,
    created_at: r.created_at as string,
  };
}

function rowToBatch(r: Row): PipelineBatch {
  return {
    id: r.id as string,
    batch_type: r.batch_type as string,
    cf_batch_id: (r.cf_batch_id as string) ?? null,
    group_id: (r.group_id as number) ?? null,
    status: r.status as string,
    image_ids: parseIdArray(r.image_ids),
    retry_count: (r.retry_count as number) ?? 0,
    error_msg: (r.error_msg as string) ?? null,
    submitted_at: (r.submitted_at as string) ?? null,
    completed_at: (r.completed_at as string) ?? null,
    created_at: r.created_at as string,
  };
}

const RAW_COLS =
  'id, r2_key, original_filename, capture_ts, date_source, phash, width, height, file_size_bytes, blur_score, exposure_score, vlm_caption, vlm_quality_score, vlm_candidate_tags, vectorize_id, group_id, is_hero, pipeline_status, batch_id, created_at';
const GROUP_COLS =
  'id, title, proposed_date_range, capture_ts_min, capture_ts_max, status, description_draft, description_final, tags_draft, tags_final, interview_questions, interview_answers, project_id, created_at';
const BATCH_COLS =
  'id, batch_type, cf_batch_id, group_id, status, image_ids, retry_count, error_msg, submitted_at, completed_at, created_at';

/* --------------------------- raw_images --------------------------- */

export async function insertRawImage(DB: D1Database, data: RawImageInsert): Promise<number> {
  const res = await DB.prepare(
    `INSERT INTO raw_images (r2_key, original_filename, capture_ts, date_source, phash, width, height, file_size_bytes, group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      data.r2_key,
      data.original_filename,
      data.capture_ts ?? null,
      data.date_source ?? null,
      data.phash ?? null,
      data.width ?? null,
      data.height ?? null,
      data.file_size_bytes ?? null,
      data.group_id ?? null
    )
    .run();
  return res.meta.last_row_id as number;
}

export async function getRawImage(DB: D1Database, id: number): Promise<RawImage | null> {
  const row = await DB.prepare(`SELECT ${RAW_COLS} FROM raw_images WHERE id = ?`).bind(id).first<Row>();
  return row ? rowToRawImage(row) : null;
}

export async function listRawImagesByGroup(DB: D1Database, groupId: number): Promise<RawImage[]> {
  const { results } = await DB.prepare(
    `SELECT ${RAW_COLS} FROM raw_images WHERE group_id = ? ORDER BY capture_ts ASC, id ASC`
  )
    .bind(groupId)
    .all<Row>();
  return (results ?? []).map(rowToRawImage);
}

// Images in a group that have survived (or not yet been through) technical culling.
export async function listCulledImages(DB: D1Database, groupId: number): Promise<RawImage[]> {
  const { results } = await DB.prepare(
    `SELECT ${RAW_COLS} FROM raw_images WHERE group_id = ? AND pipeline_status = 'culled' ORDER BY capture_ts ASC, id ASC`
  )
    .bind(groupId)
    .all<Row>();
  return (results ?? []).map(rowToRawImage);
}

export async function updateRawImageVlm(DB: D1Database, id: number, data: VlmResult): Promise<void> {
  await DB.prepare(
    `UPDATE raw_images SET vlm_caption = ?, vlm_quality_score = ?, vlm_candidate_tags = ?, pipeline_status = ? WHERE id = ?`
  )
    .bind(
      data.vlm_caption,
      data.vlm_quality_score,
      JSON.stringify(data.vlm_candidate_tags ?? []),
      data.pipeline_status ?? 'vlm_done',
      id
    )
    .run();
}

export async function updateRawImageStatus(DB: D1Database, id: number, status: string): Promise<void> {
  await DB.prepare(`UPDATE raw_images SET pipeline_status = ? WHERE id = ?`).bind(status, id).run();
}

export async function setRawImageVectorizeId(
  DB: D1Database,
  id: number,
  vectorizeId: string,
  status = 'embedded'
): Promise<void> {
  await DB.prepare(`UPDATE raw_images SET vectorize_id = ?, pipeline_status = ? WHERE id = ?`)
    .bind(vectorizeId, status, id)
    .run();
}

// Mark the given images as published heroes. Chunked to stay under D1's bound-variable limit.
export async function markRawImagesPublished(DB: D1Database, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const CHUNK = 90;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await DB.prepare(
      `UPDATE raw_images SET pipeline_status = 'published', is_hero = 1 WHERE id IN (${placeholders})`
    )
      .bind(...slice)
      .run();
  }
}

// Release images from a dead batch: send any still 'vlm_pending' back to 'culled'
// so they no longer show as stuck and can be re-submitted.
export async function revertImagesToCulled(DB: D1Database, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const CHUNK = 90;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await DB.prepare(
      `UPDATE raw_images SET pipeline_status = 'culled', batch_id = NULL
       WHERE id IN (${placeholders}) AND pipeline_status = 'vlm_pending'`
    )
      .bind(...slice)
      .run();
  }
}

// Reset VLM results for a group's images so it can be re-submitted.
export async function resetGroupVlm(DB: D1Database, groupId: number): Promise<void> {
  await DB.prepare(
    `UPDATE raw_images
       SET vlm_caption = NULL, vlm_quality_score = NULL, vlm_candidate_tags = NULL,
           vectorize_id = NULL, batch_id = NULL, pipeline_status = 'culled'
     WHERE group_id = ? AND pipeline_status IN ('vlm_pending','vlm_done','embedded')`
  )
    .bind(groupId)
    .run();
}

/* -------------------------- pipeline_groups -------------------------- */

export async function insertGroup(DB: D1Database, data: GroupInsert): Promise<number> {
  const res = await DB.prepare(
    `INSERT INTO pipeline_groups (title, proposed_date_range, capture_ts_min, capture_ts_max, status)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      data.title ?? null,
      data.proposed_date_range ?? null,
      data.capture_ts_min ?? null,
      data.capture_ts_max ?? null,
      data.status ?? 'proposed'
    )
    .run();
  return res.meta.last_row_id as number;
}

export async function getGroup(DB: D1Database, id: number): Promise<PipelineGroup | null> {
  const row = await DB.prepare(`SELECT ${GROUP_COLS} FROM pipeline_groups WHERE id = ?`)
    .bind(id)
    .first<Row>();
  return row ? rowToGroup(row) : null;
}

export interface GroupSummary extends PipelineGroup {
  image_count: number;
}

export async function listGroups(DB: D1Database, status?: string): Promise<GroupSummary[]> {
  const base = `SELECT g.*, (SELECT COUNT(*) FROM raw_images r WHERE r.group_id = g.id) AS image_count
                FROM pipeline_groups g`;
  const stmt = status
    ? DB.prepare(`${base} WHERE g.status = ? ORDER BY g.capture_ts_min ASC, g.id ASC`).bind(status)
    : DB.prepare(`${base} ORDER BY g.capture_ts_min ASC, g.id ASC`);
  const { results } = await stmt.all<Row>();
  return (results ?? []).map((r) => ({ ...rowToGroup(r), image_count: (r.image_count as number) ?? 0 }));
}

// Partial update. Array fields are JSON-stringified; only provided keys are written.
export async function updateGroup(
  DB: D1Database,
  id: number,
  data: Partial<GroupUpdate>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const arrayKeys = new Set([
    'tags_draft',
    'tags_final',
    'interview_questions',
    'interview_answers',
  ]);
  for (const [key, value] of Object.entries(data)) {
    sets.push(`${key} = ?`);
    if (arrayKeys.has(key)) {
      binds.push(value == null ? null : JSON.stringify(value));
    } else {
      binds.push(value ?? null);
    }
  }
  if (!sets.length) return;
  binds.push(id);
  await DB.prepare(`UPDATE pipeline_groups SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
}

// Move all of source group's images into target, then delete the now-empty source.
export async function mergeGroups(DB: D1Database, sourceId: number, targetId: number): Promise<void> {
  await DB.batch([
    DB.prepare(`UPDATE raw_images SET group_id = ? WHERE group_id = ?`).bind(targetId, sourceId),
    DB.prepare(`DELETE FROM pipeline_groups WHERE id = ?`).bind(sourceId),
  ]);
}

// Create a new proposed group and move the named images into it. Returns new group id.
export async function splitGroup(
  DB: D1Database,
  sourceGroupId: number,
  imageIds: number[]
): Promise<number> {
  const source = await getGroup(DB, sourceGroupId);
  const newId = await insertGroup(DB, {
    title: source?.title ? `${source.title} (split)` : null,
    status: 'proposed',
  });
  if (imageIds.length) {
    const CHUNK = 89; // leave room for the group-id bind
    for (let i = 0; i < imageIds.length; i += CHUNK) {
      const slice = imageIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      await DB.prepare(
        `UPDATE raw_images SET group_id = ? WHERE id IN (${placeholders}) AND group_id = ?`
      )
        .bind(newId, ...slice, sourceGroupId)
        .run();
    }
  }
  return newId;
}

/* -------------------------- pipeline_batches -------------------------- */

export async function insertBatch(DB: D1Database, data: BatchInsert): Promise<string> {
  await DB.prepare(
    `INSERT INTO pipeline_batches (id, batch_type, cf_batch_id, group_id, status, image_ids, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      data.id,
      data.batch_type,
      data.cf_batch_id ?? null,
      data.group_id ?? null,
      data.status ?? 'submitted',
      JSON.stringify(data.image_ids ?? [])
    )
    .run();
  return data.id;
}

export async function getBatch(DB: D1Database, id: string): Promise<PipelineBatch | null> {
  const row = await DB.prepare(`SELECT ${BATCH_COLS} FROM pipeline_batches WHERE id = ?`)
    .bind(id)
    .first<Row>();
  return row ? rowToBatch(row) : null;
}

// Batches that may still need polling.
export async function listPendingBatches(DB: D1Database): Promise<PipelineBatch[]> {
  const { results } = await DB.prepare(
    `SELECT ${BATCH_COLS} FROM pipeline_batches WHERE status IN ('submitted','processing') ORDER BY created_at ASC`
  ).all<Row>();
  return (results ?? []).map(rowToBatch);
}

export async function updateBatchStatus(
  DB: D1Database,
  id: string,
  status: string,
  cfBatchId?: string | null
): Promise<void> {
  const completedClause = status === 'complete' || status === 'failed' ? `, completed_at = datetime('now')` : '';
  if (cfBatchId !== undefined) {
    await DB.prepare(
      `UPDATE pipeline_batches SET status = ?, cf_batch_id = ?${completedClause} WHERE id = ?`
    )
      .bind(status, cfBatchId, id)
      .run();
  } else {
    await DB.prepare(`UPDATE pipeline_batches SET status = ?${completedClause} WHERE id = ?`)
      .bind(status, id)
      .run();
  }
}

export async function incrementBatchRetry(DB: D1Database, id: string, error: string): Promise<void> {
  await DB.prepare(
    `UPDATE pipeline_batches SET retry_count = retry_count + 1, error_msg = ? WHERE id = ?`
  )
    .bind(error, id)
    .run();
}

// Attach all of a group's culled images to a batch and flip them to vlm_pending.
export async function markImagesPending(
  DB: D1Database,
  ids: number[],
  batchId: string
): Promise<void> {
  if (!ids.length) return;
  const CHUNK = 89;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await DB.prepare(
      `UPDATE raw_images SET pipeline_status = 'vlm_pending', batch_id = ? WHERE id IN (${placeholders})`
    )
      .bind(batchId, ...slice)
      .run();
  }
}
