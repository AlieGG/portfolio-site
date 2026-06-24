import { defineMiddleware } from 'astro:middleware';
import { verifyAccessJwt } from './lib/access';

// Gate /admin and /api/admin. Cloudflare Access is the primary gate (configured
// in the dashboard); this middleware is defense-in-depth: it verifies the Access
// JWT signature + audience and confirms the email matches ADMIN_EMAIL.
//
// In local dev there is no Access in front, so we bypass with ADMIN_EMAIL to
// allow building/testing the dashboard.
const PROTECTED = [/^\/admin(\/|$)/, /^\/api\/admin(\/|$)/];

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, locals, url } = context;
  locals.adminEmail = null;

  const needsAuth = PROTECTED.some((re) => re.test(url.pathname));
  if (!needsAuth) return next();

  const env = locals.runtime?.env as Env | undefined;
  const allowed = (env?.ADMIN_EMAIL ?? '').trim().toLowerCase();

  if (import.meta.env.DEV) {
    locals.adminEmail = allowed || 'dev@local';
    return next();
  }

  // Fail closed: an unconfigured allowlist must deny, never allow-all.
  if (!allowed) return new Response('Forbidden', { status: 403 });

  let email: string | null = null;
  try {
    if (env) email = await verifyAccessJwt(request, env);
  } catch {
    // Verification error (e.g. JWKS fetch failure) → deny, don't 500.
    return new Response('Forbidden', { status: 403 });
  }

  if (!email || email.toLowerCase() !== allowed) {
    return new Response('Forbidden', { status: 403 });
  }

  locals.adminEmail = email;
  return next();
});
