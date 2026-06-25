# alie.dev — portfolio + admin

Creative-technologist portfolio (the "RGB_OS" design) rebuilt as a fast, responsive
[Astro](https://astro.build) site on **Cloudflare Workers**, with a projects CMS.

- **Frontend** — Astro SSR. The whole site is server-rendered HTML; the only client
  JS is the animation engine (`src/scripts/rgb-os.ts`, ~7 KB gzipped) which hydrates
  on idle so it never blocks first paint.
- **Data** — Cloudflare **D1** (`projects`, `project_images`).
- **Media** — Cloudflare **Images** (responsive AVIF/WebP variants).
- **Admin** — `/admin`, gated by **Cloudflare Access**. Add/edit/reorder projects,
  drag-drop image upload with per-image captions.

## Local development

```bash
npm install
npm run db:local        # create local D1 schema
npm run db:seed:local   # seed the 6 starter projects
npm run dev             # http://localhost:4321  (admin at /admin — auth bypassed locally)
```

`astro dev` bypasses Access locally so you can build/test the admin. Image **upload**
needs real Cloudflare Images credentials (see `.dev.vars.example` → copy to `.dev.vars`);
everything else works offline.

To exercise the real Cloudflare runtime locally: `npm run build && npx wrangler dev`
(admin will 403 there by design — that path is only reachable through Access).

## One-time Cloudflare setup

All of this is on the existing **$5 Workers Paid + Images** plan — no extra cost.

### 1. D1 database
```bash
npx wrangler d1 create alie_portfolio
```
Copy the printed `database_id` into `wrangler.jsonc` (replace `PLACEHOLDER_RUN_D1_CREATE`),
then apply schema + seed to the remote DB:
```bash
npm run db:remote
npm run db:seed:remote
```

### 2. Cloudflare Images
1. Dashboard → **Images** → enable it (included in the plan).
2. Enable **Flexible variants** (Images → Variants → "Enable flexible variants").
   This lets the site request arbitrary widths like `…/w=600,q=82,f=auto` for `srcset`.
3. Note your **Account Hash** (Images → Overview → the `imagedelivery.net/<hash>/…` value).
4. Create an **API token** (My Profile → API Tokens → Create) with permission
   **Account › Cloudflare Images › Edit**. Save the token.

### 3. Cloudflare Access (protects /admin)
1. Zero Trust dashboard → **Access → Applications → Add a self-hosted application**.
2. Application domain: `alie.dev`, path `admin` (add a second for `api/admin`).
   Or protect the whole site path `admin*` — both `/admin` and `/api/admin/*` must be covered.
3. Policy: **Allow**, rule = Emails → `alie33129@gmail.com` (Google login or one-time PIN).
4. After creating, copy the **Application Audience (AUD) tag** and your team domain
   (`<team>.cloudflareaccess.com`).

### 4. Config values

Put the **non-secret** values in `wrangler.jsonc` → `vars`:
```jsonc
"CF_IMAGES_ACCOUNT_HASH": "<account hash>",
"CF_ACCOUNT_ID":          "<account id>",
"ADMIN_EMAIL":            "alie33129@gmail.com",
"ACCESS_TEAM_DOMAIN":     "<team>.cloudflareaccess.com",
"ACCESS_AUD":             "<application AUD tag>"
```

Set the **secret**:
```bash
npx wrangler secret put CF_IMAGES_TOKEN   # paste the Images API token
```

### 5. Deploy + custom domain
```bash
npm run deploy           # astro build && wrangler deploy
```
Then in the dashboard: Workers & Pages → `alie-portfolio` → **Settings → Domains & Routes**
→ add custom domain `alie.dev` (and `www.alie.dev`). DNS is already on Cloudflare, so this
just creates the route — do this last; it's the only outward-facing switch.

## Deploy to production

See [DEPLOY.md](DEPLOY.md) for the full one-time Cloudflare setup and
deployment steps.

## After deploy

- Visit `/admin`, log in via Access, and upload real images for each project
  (the seeded cards show a "NO IMAGE YET" placeholder until you do).
- Set the real **social URLs** in `src/components/Contact.astro` (Instagram / GitHub /
  LinkedIn hrefs are placeholders). Then redeploy.

## Notes

- New/edited projects appear within ~60s (the homepage HTML is edge-cached
  `s-maxage=60, stale-while-revalidate`); no redeploy needed for content changes.
- Reduced-motion / accessibility: the engine starts in **Calm** mode automatically when
  the browser requests `prefers-reduced-motion`. Users can toggle FULL/CALM in the header.
- The Cloudflare adapter mentions a `SESSION` KV binding on build. The site doesn't use
  Astro sessions, so no binding is required; ignore the message. (If you ever use
  `Astro.session`, create a KV namespace and bind it as `SESSION`.)

## Project layout

```
src/
  pages/
    index.astro            one-page site (SSR Work section from D1)
    admin/index.astro      dashboard shell
    api/admin/…            Access-gated CRUD + Images direct-upload
  components/…             one .astro per section (Hero, Work, About, …)
  scripts/
    rgb-os.ts              the animation engine (canvas LEDs, boot, cursor, reveals)
    admin.ts               dashboard logic
  lib/  db.ts  images.ts  access.ts  api.ts
db/  schema.sql  seed.sql
scratch/                   extracted source assets (gitignored, not deployed)
```

## License

- **Code** — MIT License. See [`LICENSE`](LICENSE). You may use, copy, modify,
  merge, publish, distribute, sublicense, and/or sell copies of the code,
  provided the MIT notice is included.
- **Content** — © 2026 Alie Gonzalez-Guyon. All Rights Reserved. All images,
  project copy, portraits, branding, and other creative content are not licensed
  for reuse without explicit written permission.
- **Third-party fonts** — JetBrains Mono and Space Grotesk are distributed under
  the SIL Open Font License 1.1.
## CI/CD

- `.github/workflows/ci.yml` runs the build on every push and PR.
- `.github/workflows/deploy.yml` deploys to Cloudflare automatically on every push to `main` once you add `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID` (variable) in the GitHub repo settings.
