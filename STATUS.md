# Deployment status — alie.dev

**Status: ✅ LIVE & operational** (deployed 2026-06-30)

## URLs
- **https://alie.dev** — the portfolio (primary)
- **https://www.alie.dev** — same site
- **https://alie.dev/admin** — projects dashboard (login-gated)
- `https://alie-portfolio.flux-505.workers.dev` — fallback Workers URL

## Admin login
- Go to **/admin** → Cloudflare Access login → sign in as **flux@alie.dev**.
- Two places must agree on this email or the Worker returns 403 after login:
  1. Cloudflare Access policy ("alie.dev" app → policy "Me" → Emails)
  2. `ADMIN_EMAIL` var in `wrangler.jsonc`
- To use a different login email, change **both** and `npm run deploy`.

## What the admin does
Pick a project → drag images into the drop zone (uploads to Cloudflare Images) →
add a caption per image, reorder images, reorder/publish projects. The live site
reflects changes within ~60s (edge cache), no redeploy needed.

## Cloudflare resources (account: flux@alie.dev / 5057132d8bf358607b75512371711d57)
| Resource | Value |
|---|---|
| Worker | `alie-portfolio` |
| D1 database | `alie_portfolio` (id `2383504b-6493-4c3e-a0d5-48efd47ce000`) |
| Images account hash | `_FJKR_shvd8XCezQ0-PsUw` |
| Access team | `morning-cake-bdfd.cloudflareaccess.com` |
| Access app | "alie.dev" → protects `/admin` + `/api/admin` |
| Secret | `CF_IMAGES_TOKEN` (Worker secret; not in repo) |

All non-secret values are committed in `wrangler.jsonc`.

## Redeploy
```bash
npm run deploy        # astro build && wrangler deploy
```
DB schema/seed changes: `npm run db:remote` / `npm run db:seed:remote`.

## Architecture
Astro SSR on Cloudflare Workers · D1 (projects + images) · Cloudflare Images
(responsive AVIF/WebP) · Cloudflare Access (admin auth) · animation engine in
`src/scripts/rgb-os.ts` (~7 KB gz, idle-hydrated). See `README.md` for full setup
and `src/` layout.

## Gotchas (for future deploys)
- `public/.assetsignore` (lists `_worker.js`, `_routes.json`) is **required** or
  `wrangler deploy` errors on the `_worker.js` directory.
- The custom-domain attach only worked after the old Squarespace `alie.dev` **A**
  record + `www` **CNAME** were deleted. Gmail **MX**/**TXT** records were kept.

## Optional follow-ups (cosmetic, not blocking)
- [ ] Upload real project images via /admin (cards show "NO IMAGE YET" until then).
- [x] ~~Set real social URLs~~ — Instagram/GitHub/LinkedIn wired (2026-06-30).
- [ ] Add a custom OG share image for nicer link previews.
