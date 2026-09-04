# Migrating the frontend: Cloudflare Pages (next-on-pages) → Workers (OpenNext)

**Goal:** move `apps/web` from the *deprecated* `@cloudflare/next-on-pages` (Pages, edge runtime) to
`@opennextjs/cloudflare` (Workers, **Node.js runtime**). This removes the edge-runtime constraints that
have been causing build friction (e.g. the `app/icon.png` route error) and puts you on Cloudflare's
officially recommended, non-deprecated path.

> **Prepared, not flipped.** Phase A below is safe to commit today — it does **not** affect the current
> Pages build. Phase B is the actual cutover; do it in one sitting when you're ready, and keep the Pages
> project around as an instant rollback.

---

## Facts about *this* repo (already checked)

- Monorepo; the app is at **`apps/web`** (Cloudflare "v2 root directory strategy").
- Current Pages build command:
  `npm install -D @cloudflare/next-on-pages@1 --legacy-peer-deps && npx @cloudflare/next-on-pages@1`
- **3 edge routes** that must lose `export const runtime = 'edge'` on flip day:
  - `app/api/consults/route.ts`
  - `app/api/consults/[id]/route.ts`
  - `app/api/consults/[id]/approve/route.ts`
- `next.config.js` is CommonJS and has a `/backend/:path*` → `$BACKEND` rewrite (keep it; works on Node runtime).
- Host-split `middleware.ts` (apex → `/marketing`) — works unchanged on Workers.
- No `wrangler.*` config yet.
- Env the app needs at build/runtime: `BACKEND_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`.

---

## Prerequisites

- **Wrangler ≥ 3.99.0** (required by OpenNext).
- A Cloudflare account with **Workers** enabled (it is by default).
- Optional but recommended: **R2** enabled (for Next incremental/ISR cache). You have almost no ISR today,
  so this is low priority — you can skip R2 at first and add it later.

---

## Phase A — Prepare (safe to commit now; does not touch the Pages build)

All paths below are inside **`apps/web/`**.

### A1. Install the adapter + wrangler

```bash
cd apps/web
npm install --save-dev @opennextjs/cloudflare@latest wrangler@latest
```

### A2. Add `apps/web/wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "notera-web",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-12-30",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "notera-web" }
  ],
  // Uncomment after you create the R2 bucket (Phase B, optional):
  // "r2_buckets": [
  //   { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "notera-web-cache" }
  // ],
  "images": { "binding": "IMAGES" },

  // Runtime env vars (non-secret). Secrets go via `wrangler secret put` (see B4).
  "vars": {
    "NEXT_PUBLIC_SITE_URL": "https://aitoolsfordoctor.com",
    "NEXT_PUBLIC_APP_URL": "https://app.aitoolsfordoctor.com",
    "BACKEND_URL": "https://<your-backend-origin>"
  }
}
```

> `name` must match the `WORKER_SELF_REFERENCE` service binding. Keep `main`/`assets` as-is.

### A3. Add `apps/web/open-next.config.ts`

Minimal (no R2 cache yet):

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
```

To enable R2 incremental cache later, change to:

```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });
```

### A4. Add `apps/web/.dev.vars` (local only — gitignored)

```
NEXTJS_ENV=development
BACKEND_URL=http://localhost:8080
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### A5. Add static-asset caching — `apps/web/public/_headers`

```
/_next/static/*
  Cache-Control: public,max-age=31536000,immutable
```

### A6. Add OpenNext build output to `.gitignore`

Append to the repo `.gitignore` (or `apps/web/.gitignore`):

```
.open-next
apps/web/.open-next
apps/web/.dev.vars
```

### A7. Add scripts to `apps/web/package.json`

Do **not** change the existing `"build": "next build"`. Add:

```jsonc
{
  "scripts": {
    "preview:cf": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
    "deploy:cf":  "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
    "upload:cf":  "opennextjs-cloudflare build && opennextjs-cloudflare upload",
    "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
  }
}
```

> Commit Phase A now if you like — Pages keeps building with its own command and ignores all of the above.

---

## Phase B — Flip to Workers (the cutover)

### B1. Remove the edge runtime from the 3 API routes

Delete this line from each of the three files listed above:

```ts
export const runtime = 'edge';   // required for Cloudflare Pages (@cloudflare/next-on-pages)
```

OpenNext runs them on the Node runtime instead (more capable). **This is the change that breaks the old
Pages build**, so only do it as part of the flip.

### B2. (Optional) wire local-dev bindings in `next.config`

Your `next.config.js` is CommonJS, and the dev helper is ESM. Simplest: rename to **`next.config.mjs`**
and convert, then add the dev hook:

```js
/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@notera/ui'],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${BACKEND}/:path*` }];
  },
};

export default nextConfig;

// Enables Cloudflare bindings while running `next dev`
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
```

> If you'd rather not touch dev, you can skip B2 entirely — it only affects `next dev` binding access,
> not production. `npm run preview:cf` still runs the real Workers runtime locally.

### B3. Build + preview locally in the Workers runtime

```bash
cd apps/web
npm run preview:cf
```

Click through: apex `/` (marketing), `/login`, `/app`, and the `/api/consults` routes. Fix anything that
only worked under edge (rare — mostly this "just works" better on Node).

### B4. Create the Worker + set secrets, then deploy

```bash
cd apps/web
# non-secret vars are in wrangler.jsonc; put any SECRET values here instead of vars:
# npx wrangler secret put SOME_SECRET
npm run deploy:cf
```

This creates a `notera-web` Worker and gives you a `https://notera-web.<subdomain>.workers.dev` URL.
Test everything there first.

### B5. (Optional) R2 cache

```bash
npx wrangler r2 bucket create notera-web-cache
```

Then uncomment the `r2_buckets` block in `wrangler.jsonc` and switch `open-next.config.ts` to the R2
incremental cache (A3), and redeploy.

### B6. Move the custom domains from Pages → Worker

In the Cloudflare dashboard:

1. **Workers & Pages → `notera-web` (Worker) → Settings → Domains & Routes → Add custom domain**:
   add `aitoolsfordoctor.com`, `www.aitoolsfordoctor.com`, and `app.aitoolsfordoctor.com`.
2. Cloudflare will prompt to move each domain off the existing **Pages** project — confirm.
3. Re-add the same environment variables in the Worker's **Settings → Variables** if you didn't put them
   in `wrangler.jsonc` (`BACKEND_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`).

DNS is unchanged (same proxied records); you're only repointing which CF project serves them.

### B7. Continuous deploys (replace the Pages CI)

Two options:

- **Workers Builds** (recommended): Workers & Pages → your Worker → **Builds → Connect** the GitHub repo,
  set **Root directory = `apps/web`**, build command `npx opennextjs-cloudflare build`, deploy command
  `npx wrangler deploy`. Every push to `main` deploys automatically.
- **Or** deploy from your own CI / locally with `npm run deploy:cf`.

### B8. Verify, then decommission Pages

- Confirm marketing, login, app, note generation (async polling), and `og.png`/favicon all work on the Worker.
- Leave the **old Pages project intact for ~a week** as rollback (just re-attach the domains to it if needed).
- Once confident, delete the Pages project and remove `@cloudflare/next-on-pages` + `eslint-plugin-next-on-pages`
  from `apps/web/package.json`.

---

## Rollback (instant)

If anything's wrong after B6: in the dashboard, move the three custom domains back to the **Pages** project
(Domains & Routes). Because you didn't delete Pages, this is a 30-second revert.

---

## Gotchas specific to you

- **Edge → Node**: after B1, your `/api/consults*` routes run on Node — they'll behave the same or better.
- **`/backend` rewrite**: unchanged; make sure `BACKEND_URL` is set on the Worker (B4/B6), not just in Pages.
- **Static files** (`public/og.png`, `icon.png`, `favicon.ico`, `apple-icon.png`): served from `.open-next/assets`
  automatically — the metadata `icons` refs keep working.
- **Middleware** host-split: works on Workers unchanged.
- **`ignoreBuildErrors`/`ignoreDuringBuilds`** stay as-is; OpenNext just wraps `next build`.
- **Lenis / client JS**: unaffected (client-side only).

---

## TL;DR command list

```bash
# Phase A (safe now)
cd apps/web
npm i -D @opennextjs/cloudflare@latest wrangler@latest
#  + add wrangler.jsonc, open-next.config.ts, .dev.vars, public/_headers, .gitignore, package.json scripts

# Phase B (flip day)
# 1) remove `export const runtime='edge'` from the 3 consults routes
npm run preview:cf         # test locally in Workers runtime
npm run deploy:cf          # creates the notera-web Worker
# 2) move custom domains Pages → Worker in the dashboard
# 3) connect Workers Builds (root = apps/web) for auto-deploys
# 4) keep Pages ~1 week as rollback, then delete
```
