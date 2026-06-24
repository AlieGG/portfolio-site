-- Alie.dev portfolio schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  kicker      TEXT,                       -- e.g. "INSTALLATION · 2025"
  index_label TEXT,                       -- e.g. "/01"
  summary     TEXT,                       -- hover-reveal paragraph
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  accent      TEXT,                       -- optional per-card accent color
  sort_order  INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 1, -- 0 | 1
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cf_image_id TEXT NOT NULL,              -- Cloudflare Images id
  subtitle    TEXT,                       -- caption overlaid on the carousel slide
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_order ON projects(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_images_project ON project_images(project_id, sort_order);
