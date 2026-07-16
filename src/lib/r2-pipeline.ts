// R2 helpers for the raw image archive. Inside the Worker we use the RAW_IMAGES
// binding directly (no S3 credentials needed). The CLI upload script uploads via
// the S3-compatible API separately (see scripts/upload-archive.ts).

export interface R2Bytes {
  bytes: ArrayBuffer;
  contentType: string;
}

// Read an object's bytes + content type. Returns null if the key is missing.
export async function getR2Object(env: Env, key: string): Promise<R2Bytes | null> {
  const obj = await env.RAW_IMAGES.get(key);
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  const contentType = obj.httpMetadata?.contentType || guessContentType(key);
  return { bytes, contentType };
}

// Stream an object straight back as a Response (used by the thumbnail route).
export async function r2ObjectResponse(env: Env, key: string): Promise<Response | null> {
  const obj = await env.RAW_IMAGES.get(key);
  if (!obj) return null;
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || guessContentType(key),
      'cache-control': 'private, max-age=3600',
    },
  });
}

// Encode an R2 object as a data: URL so it can be inlined into a Workers AI
// request without exposing a public URL.
export async function r2ObjectToDataUrl(env: Env, key: string): Promise<string | null> {
  const obj = await getR2Object(env, key);
  if (!obj) return null;
  return `data:${obj.contentType};base64,${bytesToBase64(obj.bytes)}`;
}

// Max edge for images sent to the VLM. Captioning doesn't need full-resolution
// photos, and the async batch API silently kills oversized submissions — a
// group of full-size JPEGs blows straight past the 10 MB payload cap.
export const VLM_IMAGE_WIDTH = 1200;

// Like r2ObjectToDataUrl, but downscaled + recompressed via the Images binding
// so a whole group fits inside a batch submission. Falls back to the original
// bytes if the binding is unavailable or the transform fails (e.g. exotic
// format) — chunking at the submit layer still bounds the payload then.
export async function r2ObjectToVlmDataUrl(env: Env, key: string): Promise<string | null> {
  const obj = await getR2Object(env, key);
  if (!obj) return null;
  try {
    if (env.IMAGES) {
      const result = await env.IMAGES.input(new Blob([obj.bytes]).stream())
        .transform({ width: VLM_IMAGE_WIDTH })
        .output({ format: 'image/jpeg', quality: 80 });
      const resized = await result.response().arrayBuffer();
      // A transform that somehow grows the file (tiny originals) is pointless.
      if (resized.byteLength < obj.bytes.byteLength) {
        return `data:image/jpeg;base64,${bytesToBase64(resized)}`;
      }
    }
  } catch (e) {
    console.warn(`VLM downscale failed for ${key}, using original: ${(e as Error).message}`);
  }
  return `data:${obj.contentType};base64,${bytesToBase64(obj.bytes)}`;
}

// Workers-native base64 (no Node Buffer). Chunked to avoid call-stack limits.
function bytesToBase64(buffer: ArrayBuffer): string {
  const arr = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}
