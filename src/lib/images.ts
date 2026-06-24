// Cloudflare Images helpers.
//
// Upload flow (keeps large files off the Worker):
//   1. Browser asks our Worker for a one-time direct-upload URL.
//   2. Worker calls the Images API with the secret token, returns { uploadURL, id }.
//   3. Browser POSTs the file straight to uploadURL (Cloudflare).
//   4. Browser tells our Worker the returned image id; we store it in D1.
//
// Delivery uses flexible variants so we can request arbitrary widths for srcset:
//   https://imagedelivery.net/<ACCOUNT_HASH>/<image_id>/w=<width>,q=82,f=auto
// Flexible variants must be enabled once on the account (see README).

const API = 'https://api.cloudflare.com/client/v4';

interface DirectUpload {
  uploadURL: string;
  id: string;
}

export async function getDirectUploadUrl(env: Env): Promise<DirectUpload> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/images/v2/direct_upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
    // requireSignedURLs:false so the delivery URLs are publicly viewable.
    body: (() => {
      const fd = new FormData();
      fd.set('requireSignedURLs', 'false');
      return fd;
    })(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Images direct_upload HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    success: boolean;
    result?: DirectUpload;
    errors?: unknown;
  };
  if (!json.success || !json.result) {
    throw new Error(`Images direct_upload failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

export async function deleteCfImage(env: Env, imageId: string): Promise<void> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/images/v1/${imageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
  });
  // Callers swallow rejections (best-effort cleanup), so log orphans here so
  // they're observable in Workers logs rather than silently accruing storage.
  if (!res.ok && res.status !== 404) {
    console.warn(`Cloudflare Images delete failed for ${imageId}: HTTP ${res.status}`);
  }
}

/** Single delivery URL at a given flexible-variant spec (default: a sane card width). */
export function imageUrl(
  accountHash: string,
  imageId: string,
  opts: { w?: number; q?: number; fit?: string } = {}
): string {
  const { w = 800, q = 82, fit = 'cover' } = opts;
  return `https://imagedelivery.net/${accountHash}/${imageId}/w=${w},q=${q},fit=${fit},f=auto`;
}

/** Responsive srcset string across the given widths. */
export function imageSrcset(
  accountHash: string,
  imageId: string,
  widths: number[] = [400, 600, 800, 1200]
): string {
  return widths
    .map((w) => `${imageUrl(accountHash, imageId, { w })} ${w}w`)
    .join(', ');
}
