// D1 access layer for projects + their carousel images.
// All queries are parameterized. Tag arrays are stored as JSON text.

export interface ProjectImage {
  id: number;
  project_id: number;
  cf_image_id: string;
  subtitle: string | null;
  sort_order: number;
}

export interface Project {
  id: number;
  title: string;
  kicker: string | null; // e.g. "INSTALLATION · 2025"
  index_label: string | null; // e.g. "/01"
  summary: string | null; // hover-reveal paragraph
  tags: string[];
  accent: string | null; // optional per-card accent color
  sort_order: number;
  published: number; // 0 | 1
  created_at: string;
  images: ProjectImage[];
}

export interface ProjectInput {
  title: string;
  kicker?: string | null;
  index_label?: string | null;
  summary?: string | null;
  tags?: string[];
  accent?: string | null;
  published?: boolean;
}

type Row = Record<string, unknown>;

function rowToProject(p: Row, images: ProjectImage[]): Project {
  let tags: string[] = [];
  try {
    tags = p.tags ? JSON.parse(p.tags as string) : [];
  } catch {
    tags = [];
  }
  return {
    id: p.id as number,
    title: p.title as string,
    kicker: (p.kicker as string) ?? null,
    index_label: (p.index_label as string) ?? null,
    summary: (p.summary as string) ?? null,
    tags,
    accent: (p.accent as string) ?? null,
    sort_order: p.sort_order as number,
    published: p.published as number,
    created_at: p.created_at as string,
    images,
  };
}

async function attachImages(DB: D1Database, projects: Row[]): Promise<Project[]> {
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id as number);
  // Chunk to stay under SQLite's bound-variable limit (~100 on D1).
  const CHUNK = 90;
  const rows: ProjectImage[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const { results } = await DB.prepare(
      `SELECT * FROM project_images WHERE project_id IN (${placeholders}) ORDER BY sort_order ASC, id ASC`
    )
      .bind(...slice)
      .all<ProjectImage>();
    if (results) rows.push(...results);
  }
  const byProject = new Map<number, ProjectImage[]>();
  for (const img of rows) {
    const arr = byProject.get(img.project_id) ?? [];
    arr.push(img);
    byProject.set(img.project_id, arr);
  }
  return projects.map((p) => rowToProject(p, byProject.get(p.id as number) ?? []));
}

export async function getPublishedProjects(DB: D1Database): Promise<Project[]> {
  const { results } = await DB.prepare(
    `SELECT * FROM projects WHERE published = 1 ORDER BY sort_order ASC, id ASC`
  ).all<Row>();
  return attachImages(DB, results ?? []);
}

export async function getAllProjects(DB: D1Database): Promise<Project[]> {
  const { results } = await DB.prepare(
    `SELECT * FROM projects ORDER BY sort_order ASC, id ASC`
  ).all<Row>();
  return attachImages(DB, results ?? []);
}

export async function getProject(DB: D1Database, id: number): Promise<Project | null> {
  const row = await DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<Row>();
  if (!row) return null;
  const [project] = await attachImages(DB, [row]);
  return project;
}

export async function createProject(DB: D1Database, input: ProjectInput): Promise<number> {
  const next = await DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM projects`
  ).first<{ n: number }>();
  const res = await DB.prepare(
    `INSERT INTO projects (title, kicker, index_label, summary, tags, accent, sort_order, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.title,
      input.kicker ?? null,
      input.index_label ?? null,
      input.summary ?? null,
      JSON.stringify(input.tags ?? []),
      input.accent ?? null,
      next?.n ?? 0,
      input.published === false ? 0 : 1
    )
    .run();
  return res.meta.last_row_id as number;
}

export async function updateProject(
  DB: D1Database,
  id: number,
  input: ProjectInput
): Promise<void> {
  await DB.prepare(
    `UPDATE projects SET title = ?, kicker = ?, index_label = ?, summary = ?, tags = ?, accent = ?, published = ?
     WHERE id = ?`
  )
    .bind(
      input.title,
      input.kicker ?? null,
      input.index_label ?? null,
      input.summary ?? null,
      JSON.stringify(input.tags ?? []),
      input.accent ?? null,
      input.published === false ? 0 : 1,
      id
    )
    .run();
}

export async function deleteProject(DB: D1Database, id: number): Promise<ProjectImage[]> {
  // Return the images first so the caller can delete them from Cloudflare Images.
  const { results } = await DB.prepare(
    `SELECT * FROM project_images WHERE project_id = ?`
  )
    .bind(id)
    .all<ProjectImage>();
  await DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run();
  return results ?? [];
}

export async function reorderProjects(DB: D1Database, orderedIds: number[]): Promise<void> {
  const stmts = orderedIds.map((id, i) =>
    DB.prepare(`UPDATE projects SET sort_order = ? WHERE id = ?`).bind(i, id)
  );
  if (stmts.length) await DB.batch(stmts);
}

export async function addImage(
  DB: D1Database,
  projectId: number,
  cfImageId: string,
  subtitle: string | null
): Promise<number> {
  const next = await DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM project_images WHERE project_id = ?`
  )
    .bind(projectId)
    .first<{ n: number }>();
  const res = await DB.prepare(
    `INSERT INTO project_images (project_id, cf_image_id, subtitle, sort_order) VALUES (?, ?, ?, ?)`
  )
    .bind(projectId, cfImageId, subtitle, next?.n ?? 0)
    .run();
  return res.meta.last_row_id as number;
}

export async function updateImageSubtitle(
  DB: D1Database,
  imageId: number,
  subtitle: string | null
): Promise<void> {
  await DB.prepare(`UPDATE project_images SET subtitle = ? WHERE id = ?`)
    .bind(subtitle, imageId)
    .run();
}

export async function deleteImage(DB: D1Database, imageId: number): Promise<string | null> {
  const row = await DB.prepare(`SELECT cf_image_id FROM project_images WHERE id = ?`)
    .bind(imageId)
    .first<{ cf_image_id: string }>();
  await DB.prepare(`DELETE FROM project_images WHERE id = ?`).bind(imageId).run();
  return row?.cf_image_id ?? null;
}

export async function reorderImages(DB: D1Database, orderedIds: number[]): Promise<void> {
  const stmts = orderedIds.map((id, i) =>
    DB.prepare(`UPDATE project_images SET sort_order = ? WHERE id = ?`).bind(i, id)
  );
  if (stmts.length) await DB.batch(stmts);
}
