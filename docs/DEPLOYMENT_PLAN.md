# Notera — Production Deployment Runbook (GCP VM + Cloudflare + Vertex)

Do‑this‑in‑order runbook for **your** setup, with your real values filled in:

- **Frontend** → Cloudflare Pages · `aitoolsfordoctor.com` (marketing) + `app.aitoolsfordoctor.com` (app)
- **Backend + PostgreSQL** → one `e2-small` GCP VM (~$13/mo), DB co‑located, behind Cloudflare
- **API host** → `api.aitoolsfordoctor.com` (orange‑cloud proxied, WAF‑protected)
- **LLM** → Vertex AI, `global` endpoint, `gemini-3.7-flash`, project `medproject-506019` (BAA signed ✅)
- **Auth** → self‑hosted email/password (already built in the repo)
- **No Cloud Run / Cloud SQL / NER.**

Steps already **done for you** (skip them): all backend code (auth, hardening, Vertex, Docker/compose/Caddy), and your secrets are already generated into local files — `.env.production`, `secrets/sa-key.json`, `db/secrets/pg_password`. You'll copy those to the VM in Part A‑5.

> ⚠️ **Rotate the two secrets you pasted in chat** (service‑account key + SMTP password) after go‑live — new SA key in the console, delete the old; change the SMTP password.

---

## Architecture

```
 Browser ─HTTPS─▶ Cloudflare edge (WAF / rate‑limit / DDoS / TLS)
        ┌──────────────┴───────────────┐
        ▼                              ▼
 aitoolsfordoctor.com            api.aitoolsfordoctor.com
 app.aitoolsfordoctor.com        (🟠 proxied → GCP VM · Caddy TLS)
 (Cloudflare Pages · Next.js)       ├── backend (Express :8080) ─ Vertex AI (Gemini, BAA)
        │  /backend/* proxy ────────▶└── postgres :5432 (same VM, private)
```

Firewall locks the VM so **only Cloudflare** can reach `:443` — the WAF cannot be bypassed by hitting the VM IP.

---

# Part A — GCP (backend + database)

### A‑1. Project + variables (local machine, `gcloud` installed)

```bash
export PROJECT_ID=medproject-506019
export REGION=us-central1 ZONE=us-central1-a
gcloud config set project $PROJECT_ID
gcloud services enable compute.googleapis.com aiplatform.googleapis.com iap.googleapis.com
```

### A‑2. Give your existing service account Vertex access

You already have `gcpdev@medproject-506019.iam.gserviceaccount.com` and its key (already saved to `secrets/sa-key.json`). Just grant it the Vertex role:

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gcpdev@medproject-506019.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### A‑3. Reserve a static IP + create the VM

```bash
gcloud compute addresses create notera-ip --region=$REGION
export IP=$(gcloud compute addresses describe notera-ip --region=$REGION --format='value(address)')
echo "VM IP = $IP     # you'll point Cloudflare's api record at this"

gcloud compute instances create notera-app \
  --zone=$ZONE --machine-type=e2-small \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=$IP \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --tags=notera-web
```

### A‑4. Firewall — SSH via IAP only (the public 443 rule comes later, in Part B‑4)

```bash
gcloud compute firewall-rules create notera-iap-ssh \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=notera-web
# temporary web rule so you can get the Origin cert working before locking to Cloudflare:
gcloud compute firewall-rules create notera-web \
  --allow=tcp:80,tcp:443 --target-tags=notera-web
```

### A‑5. On the VM — harden, install Docker, get the code + secrets

SSH in:

```bash
gcloud compute ssh notera-app --zone=$ZONE --tunnel-through-iap
```

Then on the VM:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install ufw fail2ban unattended-upgrades git
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22,80,443/tcp && sudo ufw --force enable
sudo systemctl enable --now fail2ban
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit     # re-login for the docker group
```

SSH back in, clone the repo:

```bash
gcloud compute ssh notera-app --zone=$ZONE --tunnel-through-iap
git clone <YOUR_REPO_URL> notera && cd notera
mkdir -p secrets db/secrets certs .data
```

Copy your **already‑generated** secret files from your local machine to the VM (run these **locally**, from the repo root):

```bash
gcloud compute scp .env.production notera-app:~/notera/.env.production --zone=$ZONE --tunnel-through-iap
gcloud compute scp secrets/sa-key.json notera-app:~/notera/secrets/sa-key.json --zone=$ZONE --tunnel-through-iap
gcloud compute scp db/secrets/pg_password notera-app:~/notera/db/secrets/pg_password --zone=$ZONE --tunnel-through-iap
```

Back on the VM, lock the permissions:

```bash
chmod 600 .env.production secrets/sa-key.json db/secrets/pg_password
```

### A‑6. Build, run, migrate, create the first admin

```bash
docker compose -f docker-compose.prod.yml up -d --build

# apply DB schemas
docker compose -f docker-compose.prod.yml exec backend node /app/db/migrate_auth.mjs
docker compose -f docker-compose.prod.yml exec backend node /app/db/reset.mjs

# create YOUR admin login (choose a strong ≥12-char password)
docker compose -f docker-compose.prod.yml exec \
  -e ADMIN_EMAIL=you@aitoolsfordoctor.com -e ADMIN_PASSWORD='choose-a-strong-password' \
  backend node /app/db/create_admin.mjs
```

Caddy will need the Cloudflare Origin Certificate (Part B‑3) before HTTPS works, so finish Part B next.

---

# Part B — Cloudflare (DNS, TLS, WAF, frontend)

Full detail is in **`docs/CLOUDFLARE_SETUP.md`**; the ordered steps:

### B‑1. Add the domain to Cloudflare
Add `aitoolsfordoctor.com` to your Cloudflare account and switch your registrar's **nameservers** to the two Cloudflare gives you. Wait for "Active".

### B‑2. DNS records
- `A  api  → <VM IP from A‑3>`  → **Proxied (orange)**
- `app`, `@` (apex), `www` → created automatically when you attach the Pages custom domains in B‑8 (all proxied).

### B‑3. TLS + Origin Certificate (so Full‑strict works with orange‑cloud)
1. **SSL/TLS → Overview → Full (strict).** Enable Always Use HTTPS, TLS 1.3, HTTP/3, HSTS.
2. **SSL/TLS → Origin Server → Create Certificate** for `api.aitoolsfordoctor.com`.
3. On the VM, paste the two blocks:
   ```bash
   nano ~/notera/certs/origin.pem     # the Origin Certificate
   nano ~/notera/certs/origin.key     # the Private Key
   chmod 600 ~/notera/certs/origin.key
   docker compose -f docker-compose.prod.yml up -d caddy
   ```
4. Verify: `curl https://api.aitoolsfordoctor.com/healthz` → `{"ok":true,...}`.

### B‑4. Lock the origin to Cloudflare only 🔒 (run locally)
```bash
bash scripts/gcp-firewall-cloudflare.sh
```
This allows `:443` only from Cloudflare IPs and deletes the world‑open `notera-web` rule. Re‑test the healthz URL (works via Cloudflare); hitting the raw VM IP now times out.

### B‑5. WAF + rate limiting (Security → WAF)
- Enable the **Cloudflare Managed Ruleset** + **OWASP Core Ruleset**.
- **Bots → Bot Fight Mode = On.**
- **Rate limiting rule:** if `http.host eq "app.aitoolsfordoctor.com" and http.request.uri.path eq "/backend/api/auth/login"` → 10 req / 1 min per IP → Managed Challenge. (Backend also locks accounts after 5 fails.)

### B‑6. Cache rules (Rules → Caching)
- Bypass cache for `api.` and `app.` (dynamic).
- Cache Everything for the marketing apex/`www` (fast SEO site).

### B‑7. (Recommended) Authenticated Origin Pulls
SSL/TLS → Origin Server → Authenticated Origin Pulls = On; put Cloudflare's CA at `certs/cf-origin-pull-ca.pem`; uncomment the `client_auth` block in `Caddyfile`; `docker compose up -d caddy`.

### B‑8. Deploy the frontend on Cloudflare Pages
1. In `apps/web`, add the adapter: `npm i -D @cloudflare/next-on-pages --workspace @notera/web`.
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → this repo.
   - Root directory: `apps/web`
   - Build command: `npx @cloudflare/next-on-pages`
   - Output directory: `.vercel/output/static`
3. **Environment variables:**
   - `BACKEND_URL = https://api.aitoolsfordoctor.com`
   - `NEXT_PUBLIC_SITE_URL = https://aitoolsfordoctor.com`
   - `NEXT_PUBLIC_APP_URL = https://app.aitoolsfordoctor.com`
4. **Custom domains** (Pages → your project → Custom domains): add `aitoolsfordoctor.com`, `www.aitoolsfordoctor.com`, `app.aitoolsfordoctor.com`.
5. Add `apps/web/public/` images: `og.png` (1200×630), `icon-192.png`, `icon-512.png`, `favicon.ico`.

### B‑9. Verify end‑to‑end
- `https://aitoolsfordoctor.com` → marketing landing (host‑split middleware serves it).
- `https://app.aitoolsfordoctor.com` → login page; sign in with the admin from A‑6.
- Create a clinician (calls `POST /api/auth/users`), then generate a note.

---

## What's left that only you can do

| Item | Notes |
|---|---|
| Confirm **SMTP host** for `agilepartners-ai.com` | I set `SMTP_HOST=smtp.agilepartners-ai.com` as a guess in `.env.production` — verify with your mail provider (Google Workspace → `smtp.gmail.com` + app password). |
| Add **OG + icon images** to `apps/web/public/` | referenced by metadata/manifest. |
| **Rotate** the pasted SA key + SMTP password | after go‑live. |
| `<YOUR_REPO_URL>` in A‑5 | your git remote. |
| Admin email + password (A‑6) | your choice, ≥12 chars. |

Already provided/handled: GCP project, Vertex location+model, `ADMIN_SESSION_SECRET`, Postgres password, service‑account key, domain, BAA (signed).

---

## Legal / security — clean?

Code side is done. Remaining is org/config:

- [x] Auth on every PHI route; admin/testing‑lab excluded in prod; CORS locked; prod auth‑bypass removed.
- [x] bcrypt(12) + lockout; single‑use hashed reset tokens; HttpOnly+Secure signed cookies; audit log.
- [x] Postgres private (no public port); non‑root container; secrets git‑ignored; real client IPs via Cloudflare header.
- [x] **BAA signed**; LLM on **Vertex** (`LLM_BACKEND=vertex`), not the public API key.
- [ ] Keep DeepSeek disabled (`DEEPSEEK_API_KEY` unset).
- [ ] Cloudflare WAF + rate‑limit on (Part B‑5); origin locked to Cloudflare (B‑4); Full(strict) TLS (B‑3).
- [ ] Nightly DB backup + **one tested restore** (see backup cron in `docs/HOSTING_GCP_SELF_HOSTED.md` Part L).
- [ ] Org policies: HIPAA policies, workforce training, risk assessment, breach‑response plan; consultant sign‑off before live patients.

> Your pipeline still runs its existing `deidentify → process → reidentify` flow, so even the Vertex call carries redacted text — a bonus layer on top of the BAA. No extra de‑id complexity was added, per your instruction.

---

## Vertex cost optimization (applied)

- `VERTEX_LOCATION=global` — Vertex's dynamic worldwide fleet, cheapest (no regional premium). HIPAA under a BAA doesn't require US‑only residency; if a policy/contract does, set `us-central1`.
- Keep app + model in the same project/region to avoid cross‑region egress (~$0.12/GB).
- **Batch API (‑50%)** for any future non‑real‑time job (overnight re‑processing); interactive note generation stays synchronous.
- Don't fine‑tune / deploy dedicated endpoints (idle ~$0.75+/hr) — base Gemini on the shared fleet has no idle cost.

---

## Quick local smoke test (optional, before deploying)

```bash
npm install                      # pulls bcrypt + nodemailer
npm run db:up                    # local postgres (docker)
npm run db:auth
ADMIN_EMAIL=me@test.com ADMIN_PASSWORD='localdevpassword' npm run db:admin
REQUIRE_AUTH=true npm run dev:backend
curl -i -X POST localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@test.com","password":"localdevpassword"}'   # → 200 + Set-Cookie
```
