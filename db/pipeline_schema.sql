-- Image-pipeline tables. Separate from db/schema.sql (the live site's projects).
-- Applied via `npm run db:pipeline:local` / `npm run db:pipeline:remote`.
-- Idempotent: safe to re-run.

-- Proposed / confirmed project groups. Created first so raw_images can FK to it.
CREATE TABLE IF NOT EXISTS pipeline_groups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT,                          -- human-assigned or AI-suggested
  proposed_date_range TEXT,                          -- e.g. "2024-01-14 – 2024-01-16"
  capture_ts_min      TEXT,                          -- earliest capture ts in group
  capture_ts_max      TEXT,                          -- latest capture ts in group
  status              TEXT NOT NULL DEFAULT 'proposed',
    -- proposed | confirmed | published | rejected
  description_draft   TEXT,                          -- VLM-drafted (pre-interview)
  description_final   TEXT,                          -- Kimi-synthesized (post-interview)
  tags_draft          TEXT,                          -- JSON array
  tags_final          TEXT,                          -- JSON array
  interview_questions TEXT,                          -- JSON array of question strings
  interview_answers   TEXT,                          -- JSON array of answer strings (parallel)
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw image archive (one row per original photo).
CREATE TABLE IF NOT EXISTS raw_images (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key             TEXT NOT NULL UNIQUE,           -- e.g. "raw/2024-01/IMG_1234.jpg"
  original_filename  TEXT NOT NULL,
  capture_ts         TEXT,                           -- ISO8601, NULL if unknown
  date_source        TEXT,                           -- 'exif'|'filename'|'mtime'|'manual'
  phash              TEXT,                           -- perceptual hash hex (NULL ok in MVP)
  width              INTEGER,
  height             INTEGER,
  file_size_bytes    INTEGER,
  blur_score         REAL,                           -- NULL until culled
  exposure_score     REAL,                           -- NULL until culled
  vlm_caption        TEXT,
  vlm_quality_score  REAL,                           -- 0.0–1.0
  vlm_candidate_tags TEXT,                           -- JSON array string
  vectorize_id       TEXT,                           -- Vectorize vector ID
  group_id           INTEGER REFERENCES pipeline_groups(id) ON DELETE SET NULL,
  is_hero            INTEGER NOT NULL DEFAULT 0,      -- 1 = selected hero image
  pipeline_status    TEXT NOT NULL DEFAULT 'uploaded',
    -- uploaded | culled | culled_out | vlm_pending | vlm_done | embedded | published
  batch_id           TEXT,                           -- references pipeline_batches.id
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Batch API job tracking (one per VLM or embedding submission).
CREATE TABLE IF NOT EXISTS pipeline_batches (
  id           TEXT PRIMARY KEY,                     -- UUID generated at submit time
  batch_type   TEXT NOT NULL,                        -- 'vlm_caption' | 'embedding'
  cf_batch_id  TEXT,                                 -- Workers AI batch ID
  group_id     INTEGER REFERENCES pipeline_groups(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
    -- pending | submitted | processing | complete | failed
  image_ids    TEXT NOT NULL,                        -- JSON array of raw_image IDs
  retry_count  INTEGER NOT NULL DEFAULT 0,
  error_msg    TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_images_group     ON raw_images(group_id);
CREATE INDEX IF NOT EXISTS idx_raw_images_status    ON raw_images(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_raw_images_capture   ON raw_images(capture_ts);
CREATE INDEX IF NOT EXISTS idx_pipeline_groups_status  ON pipeline_groups(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_batches_status ON pipeline_batches(status);
