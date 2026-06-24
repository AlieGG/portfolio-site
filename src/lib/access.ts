// Cloudflare Access JWT verification.
//
// Access puts a signed JWT on every request to a protected app, in the
// `Cf-Access-Jwt-Assertion` header (and a `CF_Authorization` cookie). We verify
// the RS256 signature against the team's JWKS and check the audience (AUD) tag,
// rather than blindly trusting the plaintext email header — that header alone
// could be spoofed by anything that reaches the Worker origin directly.
//
// Requires env: ACCESS_TEAM_DOMAIN (e.g. "yourteam.cloudflareaccess.com")
// and ACCESS_AUD (the Application Audience tag from the Access app).

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

// Module-scope cache (per isolate). JWKS rotates rarely; refetch on cache miss.
let jwksCache: { domain: string; keys: Record<string, CryptoKey>; fetchedAt: number } | null =
  null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function b64urlToUint8(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    b64url.length + ((4 - (b64url.length % 4)) % 4),
    '='
  );
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function getKeys(domain: string): Promise<Record<string, CryptoKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.domain === domain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const json = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(json.keys)) throw new Error('JWKS malformed');
  const keys: Record<string, CryptoKey> = {};
  for (const k of json.keys) keys[k.kid] = await importJwk(k);
  jwksCache = { domain, keys, fetchedAt: now };
  return keys;
}

function getToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = request.headers.get('Cookie') ?? '';
  const m = cookie.match(/CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

/**
 * Returns the verified user email, or null if the request is not a valid,
 * audience-matching Access token.
 */
export async function verifyAccessJwt(request: Request, env: Env): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = getToken(request);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; email?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToUint8(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToUint8(payloadB64)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const keys = await getKeys(env.ACCESS_TEAM_DOMAIN);
  const key = keys[header.kid];
  if (!key) return null;

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToUint8(sigB64),
    data
  );
  if (!ok) return null;

  // Validate claims. A missing/invalid expiry is treated as invalid, not eternal.
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;

  return typeof payload.email === 'string' ? payload.email : null;
}
