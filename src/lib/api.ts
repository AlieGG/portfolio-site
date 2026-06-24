// Small helpers for the admin JSON API.
import type { APIContext } from 'astro';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Returns the Cloudflare env if the caller is the authenticated admin, or a 403
 * Response to return early. Middleware already gates these routes via Access;
 * this is the per-handler defense-in-depth check.
 */
export function requireAdmin(ctx: APIContext): Env | Response {
  if (!ctx.locals.adminEmail) return json({ error: 'Forbidden' }, 403);
  return ctx.locals.runtime.env as Env;
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function parseId(params: Record<string, string | undefined>): number | null {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
