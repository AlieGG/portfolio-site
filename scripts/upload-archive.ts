/**
 * One-time bulk uploader for the raw photo archive.
 *
 *   npm run pipeline:upload -- --dir /path/to/photos [--dry-run]
 *
 * For each image it:
 *   1. extracts EXIF (capture time, dimensions),
 *   2. uploads the original to R2 (S3-compatible API), preserving filename,
 *   3. inserts a raw_images row in D1 (via the Cloudflare REST API).
 * Then it clusters everything into proposed pipeline_groups by capture date
 * (72-hour windows); undated images go into a single "Unsorted" group.
 *
 * Idempotent: an image whose r2_key already exists in D1 is skipped, so re-runs
 * only add new photos.
 *
 * Required env (shell or a .env file you source yourself):
 *   CF_ACCOUNT_ID            Cloudflare account id
 *   CF_API_TOKEN             API token with D1 + R2 write
 *   CF_D1_DB_ID              D1 database id (from wrangler.jsonc)
 *   R2_BUCKET                bucket name (default: portfolio-raw)
 *   CF_R2_ACCESS_KEY_ID      R2 S3 access key
 *   CF_R2_SECRET_ACCESS_KEY  R2 S3 secret
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif']);
const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h

interface Args {
  dir: string;
  dryRun: boolean;
}

interface LocalImage {
  absPath: string;
  filename: string;
  captureTs: string | null; // ISO8601
  dateSource: 'exif' | 'filename' | 'mtime';
  width: number | null;
  height: number | null;
  sizeBytes: number;
  contentType: string;
  r2Key: string;
}

/* ------------------------------ env + args ------------------------------ */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dir = '';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
  }
  if (!dir) {
    console.error('Usage: npm run pipeline:upload -- --dir /path/to/photos [--dry-run]');
    process.exit(1);
  }
  return { dir: resolve(dir), dryRun };
}

/* ------------------------------- helpers ------------------------------- */

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (IMAGE_EXTS.has(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function contentTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.heic':
      return 'image/heic';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

function dateFromFilename(name: string): string | null {
  const m = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${mo}-${d}T12:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function extractMeta(absPath: string): Promise<LocalImage> {
  const filename = basename(absPath);
  const st = await stat(absPath);
  let captureTs: string | null = null;
  let dateSource: LocalImage['dateSource'] = 'mtime';
  let width: number | null = null;
  let height: number | null = null;

  try {
    const exif = await exifr.parse(absPath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ExifImageWidth', 'ExifImageHeight'],
    });
    if (exif?.DateTimeOriginal || exif?.CreateDate) {
      const d = exif.DateTimeOriginal ?? exif.CreateDate;
      const date = d instanceof Date ? d : new Date(d);
      if (!Number.isNaN(date.getTime())) {
        captureTs = date.toISOString();
        dateSource = 'exif';
      }
    }
    width = exif?.ExifImageWidth ?? null;
    height = exif?.ExifImageHeight ?? null;
  } catch {
    /* no EXIF — fall through to filename / mtime */
  }

  if (!captureTs) {
    const fromName = dateFromFilename(filename);
    if (fromName) {
      captureTs = fromName;
      dateSource = 'filename';
    } else {
      captureTs = st.mtime.toISOString();
      dateSource = 'mtime';
    }
  }

  const yyyymm = captureTs.slice(0, 7); // YYYY-MM
  const r2Key = `raw/${yyyymm}/${filename}`;

  return {
    absPath,
    filename,
    captureTs,
    dateSource,
    width,
    height,
    sizeBytes: st.size,
    contentType: contentTypeFor(filename),
    r2Key,
  };
}

/* ------------------------------- D1 REST ------------------------------- */

const ACCOUNT_ID = requireEnv('CF_ACCOUNT_ID');
const API_TOKEN = requireEnv('CF_API_TOKEN');
const D1_DB_ID = requireEnv('CF_D1_DB_ID');

async function d1Query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    }
  );
  const json = (await res.json()) as {
    success: boolean;
    result?: { results: T[] }[];
    errors?: unknown;
  };
  if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  return json.result?.[0]?.results ?? [];
}

async function r2KeyExists(key: string): Promise<boolean> {
  const rows = await d1Query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM raw_images WHERE r2_key = ?',
    [key]
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function insertRawImageRow(img: LocalImage): Promise<number> {
  const rows = await d1Query<{ id: number }>(
    `INSERT INTO raw_images (r2_key, original_filename, capture_ts, date_source, width, height, file_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [img.r2Key, img.filename, img.captureTs, img.dateSource, img.width, img.height, img.sizeBytes]
  );
  return rows[0].id;
}

async function insertGroupRow(
  title: string | null,
  range: string | null,
  tsMin: string | null,
  tsMax: string | null
): Promise<number> {
  const rows = await d1Query<{ id: number }>(
    `INSERT INTO pipeline_groups (title, proposed_date_range, capture_ts_min, capture_ts_max, status)
     VALUES (?, ?, ?, ?, 'proposed') RETURNING id`,
    [title, range, tsMin, tsMax]
  );
  return rows[0].id;
}

async function assignGroup(imageIds: number[], groupId: number): Promise<void> {
  // Chunk to keep the SQL parameter count reasonable.
  const CHUNK = 50;
  for (let i = 0; i < imageIds.length; i += CHUNK) {
    const slice = imageIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await d1Query(`UPDATE raw_images SET group_id = ? WHERE id IN (${placeholders})`, [
      groupId,
      ...slice,
    ]);
  }
}

/* --------------------------------- R2 --------------------------------- */

const R2_BUCKET = process.env.R2_BUCKET || 'portfolio-raw';
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv('CF_R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('CF_R2_SECRET_ACCESS_KEY'),
  },
});

async function uploadToR2(img: LocalImage): Promise<void> {
  const body = await readFile(img.absPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: img.r2Key,
      Body: body,
      ContentType: img.contentType,
    })
  );
}

/* ------------------------------ clustering ----------------------------- */

interface UploadedRef {
  id: number;
  captureTs: string | null;
  dateSource: string;
}

async function clusterIntoGroups(uploaded: UploadedRef[]): Promise<void> {
  const dated = uploaded
    .filter((u) => u.captureTs && u.dateSource !== 'mtime-unknown')
    .sort((a, b) => Date.parse(a.captureTs!) - Date.parse(b.captureTs!));
  const undated = uploaded.filter((u) => !u.captureTs);

  let cluster: UploadedRef[] = [];
  let clusterStart = 0;
  const flush = async () => {
    if (!cluster.length) return;
    const tsMin = cluster[0].captureTs!;
    const tsMax = cluster[cluster.length - 1].captureTs!;
    const range = `${tsMin.slice(0, 10)} – ${tsMax.slice(0, 10)}`;
    const gid = await insertGroupRow(null, range, tsMin, tsMax);
    await assignGroup(
      cluster.map((c) => c.id),
      gid
    );
    console.log(`  group ${gid}: ${cluster.length} images (${range})`);
    cluster = [];
  };

  for (const u of dated) {
    const t = Date.parse(u.captureTs!);
    if (cluster.length === 0) {
      cluster = [u];
      clusterStart = t;
    } else if (t - clusterStart <= CLUSTER_WINDOW_MS) {
      cluster.push(u);
    } else {
      await flush();
      cluster = [u];
      clusterStart = t;
    }
  }
  await flush();

  if (undated.length) {
    const gid = await insertGroupRow('Unsorted', null, null, null);
    await assignGroup(
      undated.map((u) => u.id),
      gid
    );
    console.log(`  group ${gid}: ${undated.length} undated images (Unsorted)`);
  }
}

/* --------------------------------- main -------------------------------- */

async function main() {
  const { dir, dryRun } = parseArgs();
  console.log(`Scanning ${dir}${dryRun ? ' (dry run)' : ''}…`);
  const files = await walk(dir);
  console.log(`Found ${files.length} image files.`);

  const uploaded: UploadedRef[] = [];
  let skipped = 0;

  for (const f of files) {
    const img = await extractMeta(f);
    if (await r2KeyExists(img.r2Key)) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  would upload ${img.r2Key} (${img.dateSource} ${img.captureTs})`);
      continue;
    }
    try {
      await uploadToR2(img);
      const id = await insertRawImageRow(img);
      uploaded.push({ id, captureTs: img.captureTs, dateSource: img.dateSource });
      console.log(`  uploaded ${img.r2Key}`);
    } catch (e) {
      console.error(`  FAILED ${img.r2Key}: ${(e as Error).message}`);
    }
  }

  if (!dryRun && uploaded.length) {
    console.log('Clustering into proposed groups…');
    await clusterIntoGroups(uploaded);
  }

  const undatedCount = uploaded.filter((u) => !u.captureTs).length;
  console.log(
    `\nDone. Uploaded ${uploaded.length}, skipped ${skipped} (already present), ` +
      `${undatedCount} undated (in Unsorted group).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
