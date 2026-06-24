# Deploy alie.dev to Cloudflare

> This guide assumes the repository is already on GitHub and you have the
> [Cloudflare Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/)
> + Cloudflare Images enabled.

## 1. One-time Cloudflare setup

### D1 database
```bash
npx wrangler d1 create alie_portfolio
```
Copy the printed `database_id` into `wrangler.jsonc` (replace
`PLACEHOLDER_RUN_D1_CREATE`). Then apply schema + seed:

```bash
npm run db:remote
npm run db:seed:remote
```

### Cloudflare Images
1. Dashboard → **Images** → enable it.
2. Enable **Flexible variants** so you can request arbitrary widths.
3. Note your **Account Hash** from the delivery URL.
4. Create an API token with **Account › Cloudflare Images › Edit** permission.

### Cloudflare Access (protects /admin)
1. Zero Trust → **Access → Applications → Add self-hosted**.
2. Domain: `alie.dev`, path `admin` (and a second for `api/admin`).
3. Policy: **Allow**, email = `alie33129@gmail.com`.
4. Copy the **Application Audience (AUD) tag** and team domain
   (`<team>.cloudflareaccess.com`) into `wrangler.jsonc`.

## 2. Configure repository values

### Public vars in `wrangler.jsonc`
Fill in:

- `CF_IMAGES_ACCOUNT_HASH`
- `CF_ACCOUNT_ID`
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- `PUBLIC_IG_URL`, `PUBLIC_GH_URL`, `PUBLIC_LI_URL` (social links)

### Secret
```bash
npx wrangler secret put CF_IMAGES_TOKEN
```
Paste the Images API token.

## 3. Local development

```bash
cp .dev.vars.example .dev.vars  # fill in values
npm install
npm run db:local
npm run db:seed:local
npm run dev
```

Admin routes are bypassed in `astro dev` by design; the API relies on
Cloudflare Access in production.

## 4. Deploy

```bash
npm run deploy
```

Finally, add the custom domain `alie.dev` (and optionally `www.alie.dev`) in
**Workers & Pages → alie-portfolio → Domains & Routes**. DNS is already on
Cloudflare, so this creates the route immediately.

## Notes

- Astro 7 auto-provisions a Cloudflare KV namespace for sessions named
  `SESSION`; you do not need to create it manually.
- New/edited projects appear within ~60s due to homepage edge caching.
- Project images must be uploaded via `/admin` after deploy.
