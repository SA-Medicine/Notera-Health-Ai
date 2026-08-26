# Notera Health AI — Production Hosting on Google Cloud (GCP)

**Self‑hosted, single‑instance deployment with co‑located PostgreSQL and self‑built email authentication.**

This guide takes the Notera monorepo (Next.js web + Express backend + Python NER sidecar + PostgreSQL) and deploys it as an industry‑ready system on one Google Compute Engine VM, with the database on the *same instance*, TLS, backups, monitoring, and a from‑scratch email/password auth module that you own end‑to‑end.

> **Read this first — clinical PHI warning.** Notera processes consultation transcripts, which are Protected Health Information (PHI). Before you put a single real patient record on GCP you **must** sign a **Business Associate Agreement (BAA)** with Google and use only BAA‑covered services. The single‑VM design below is compliant *if* you follow the hardening, encryption, audit‑logging, and backup steps in Parts F–L. Pricing and the exact list of HIPAA‑covered products change over time — verify both in the Google Cloud console before go‑live.

---

## 1. Architecture at a glance

Everything runs on **one hardened Ubuntu VM** via Docker Compose. This satisfies your "database on the same instance" requirement, keeps PHI inside a single trust boundary, and is the cheapest path to production. A reverse proxy terminates TLS and is the only thing exposed to the internet.

```
                         Internet (HTTPS 443 only)
                                  │
                        ┌─────────▼──────────┐
                        │  Caddy (TLS, 443)  │   auto Let's Encrypt cert
                        └─────────┬──────────┘
        ┌─────────────────────────┼─────────────────────────┐
        │            Docker Compose network (private)         │
        │  ┌──────────┐   ┌──────────┐   ┌──────────┐         │
        │  │  web     │   │ backend  │   │  ner     │         │
        │  │ Next.js  │──▶│ Express  │──▶│ FastAPI  │         │
        │  │  :3000   │   │  :8080   │   │  :8000   │         │
        │  └──────────┘   └────┬─────┘   └──────────┘         │
        │                      │                              │
        │                ┌─────▼──────┐                       │
        │                │ postgres   │  volume: pgdata       │
        │                │  :5432     │  (encrypted disk)     │
        │                └─────┬──────┘                       │
        │                      │ nightly pg_dump              │
        └──────────────────────┼──────────────────────────────┘
                               ▼
                    GCS bucket (encrypted backups, versioned)
```

External Google services the app calls (all must be BAA‑covered): **Cloud Speech‑to‑Text** (ASR), **Cloud Storage** (audio + backups), and your LLM (**Vertex AI Gemini** — see Part J; the public Gemini API key path is *not* HIPAA‑eligible, so route Gemini through Vertex AI for real PHI). DeepSeek (Second Opinion) is a third‑party LLM and **must not** receive real PHI unless you have your own agreement with them — keep it on de‑identified/eval data only, or disable it in production.

### Why single‑VM (and when to graduate)

| | Single VM (this guide) | Managed (Cloud SQL + Cloud Run) |
|---|---|---|
| DB location | Same instance ✅ (your ask) | Separate managed service |
| Cost | Lowest (~1 VM) | Higher |
| Ops burden | You patch/back up the DB | Google manages the DB |
| Scaling | Vertical (bigger VM) | Horizontal, automatic |
| Best for | Pilot → early production, one region | High traffic, multi‑region, HA |

Start here. When you outgrow one box (sustained high CPU, need for HA/failover), the "graduate" path is Part M.

---

## 1.5 Chosen topology — Vercel frontend + GCP backend & database

This is the deployment you asked for: **Next.js (`apps/web`) on Vercel**, and **Express backend + PostgreSQL + NER on one GCP VM** (Docker Compose). The DB stays on the *same instance as the backend*, so your co‑location requirement holds, and Vercel handles the frontend CDN/build for free at your volume.

```
   Browser ──HTTPS──▶  app.notera.health  (Vercel — Next.js)
                              │
                    Next.js rewrite  /backend/* , /api/*
                              │  (server-side proxy — browser only ever sees Vercel)
                              ▼
                     api.notera.health  (GCP VM, Caddy TLS)
                        ├── backend (Express :8080)
                        ├── ner (FastAPI :8000)
                        └── postgres :5432  (same VM, private network)
```

**The key trick — proxy through Next.js, don't call GCP directly from the browser.** Your repo already rewrites `/backend/:path*` to the backend in `next.config.js`. Keep that, and point the destination at the GCP backend. Because the browser only ever talks to the Vercel domain, you get **no CORS problems and no cross‑site cookie problems** — your existing `SameSite=Lax`, host‑only HMAC cookie (`session.js`) just works, first‑party to the Vercel domain. This is why the auth module needs **zero changes** for the split.

**Vercel side:**

1. Import the repo; set **Root Directory = `apps/web`** and framework = Next.js (it detects the Turborepo).
2. In `apps/web/next.config.js`, make the rewrite destination an env var:
   ```js
   async rewrites() {
     return [{ source: '/backend/:path*', destination: `${process.env.BACKEND_URL}/:path*` }];
   }
   ```
3. Vercel → Project → Settings → Environment Variables: `BACKEND_URL = https://api.notera.health`.
4. Put the frontend on a **custom domain** (`app.notera.health`) — needed for `Secure` cookies and a professional URL.

**GCP side (backend + DB, same instance):** follow Parts A–F of this guide but:
- Provision a **smaller VM** — `e2-small` (2 GB) is enough for backend + NER + Postgres at 100 notes/day (bump to `e2-medium`/`e2-standard-2` if NER + Postgres feel tight). This is the cheapest path (~$13–25/mo flat) and co‑locates the DB.
- Drop the **`web` service** from `docker-compose.prod.yml` — Vercel serves the frontend now. Keep `backend`, `ner`, `postgres`, `caddy`.
- Point Caddy at **`api.notera.health`** and reverse‑proxy everything to `backend:8080` (no `/` → web split needed):
  ```
  api.notera.health {
      reverse_proxy backend:8080
      header Strict-Transport-Security "max-age=31536000; includeSubDomains"
  }
  ```
- Both hostnames should share the parent domain (`app.` and `api.` under `notera.health`) — cleaner cookies and a fallback if you ever bypass the proxy.

**Two things to get right:**
- **Lock the backend's CORS** to the Vercel origin only (defence in depth, since some calls may go direct). In Express: `cors({ origin: 'https://app.notera.health', credentials: true })`, and set the cookie `Secure` in production. If you ever call `api.notera.health` directly from the browser (not through the rewrite), you must also switch the cookie to `SameSite=None; Secure` — but with the proxy you won't need to.
- **Long‑running admin scans** (multi‑minute eval runs) can exceed Vercel's proxy/streaming timeout. Route those admin/eval endpoints **directly to `api.notera.health`** (authenticated, CORS‑allowed) rather than through the Next.js rewrite. Interactive single‑note generation (10–25 s) is well within limits and should stay on the proxy.

**Cost with this split (100 notes/day):** Vercel Hobby/Pro (frontend) ≈ $0–20, GCP `e2-small` VM w/ co‑located Postgres ≈ $13–25, Vertex Gemini ≈ $31–162 (Flash‑Lite → 2.5 Flash), + Speech‑to‑Text only if you transcribe audio. **≈ $45–210/month all‑in.**

Everything else in this document (hardening, TLS, backups, HIPAA checklist, the auth module in Part G, monitoring, DR) applies unchanged to the GCP VM.

---

## 2. Prerequisites

- A **Google Cloud project** with billing enabled, dedicated to Notera (don't mix with other workloads).
- **Signed Google Cloud BAA** (Console → search "Business Associate Agreement"; accept it at the org/account level). Do not proceed with real PHI until this is done.
- A **domain name** (e.g. `app.notera.health`) you control, so you can point DNS at the VM and get a TLS cert.
- **`gcloud` CLI** installed locally and authenticated (`gcloud init`).
- Repo access (the machine will `git clone` your private repo, or you'll build images in CI and pull them).

Set some shell variables you'll reuse:

```bash
export PROJECT_ID="notera-prod"
export REGION="us-central1"          # pick a region in your jurisdiction (data residency)
export ZONE="us-central1-a"
export VM_NAME="notera-app"
gcloud config set project "$PROJECT_ID"
```

---

## 3. Part A — Provision the VM

**Sizing.** The pipeline is LLM‑I/O‑bound, but the NER sidecar + Postgres + Node want real RAM. Start with **`e2-standard-4`** (4 vCPU, 16 GB). Bump to `e2-standard-8` if you run large eval scans or many concurrent clinicians.

```bash
# Reserve a static external IP (so DNS never breaks on reboot)
gcloud compute addresses create notera-ip --region="$REGION"
export STATIC_IP=$(gcloud compute addresses describe notera-ip --region="$REGION" --format='value(address)')

# Create the VM: Ubuntu 22.04 LTS, 100 GB SSD, encrypted, shielded
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-ssd \
  --address="$STATIC_IP" \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --no-service-account --no-scopes \
  --metadata=block-project-ssh-keys=true \
  --tags=notera-web
```

> `--no-service-account` is intentional: the VM should get its Google API access from a **least‑privilege service account key mounted into the containers** (Part I), not the broad default. Boot/persistent disks on GCP are **encrypted at rest by default** (AES‑256); for extra control use a **CMEK** (customer‑managed key in Cloud KMS).

**Firewall — expose only 443 (and 80 for cert issuance), and lock SSH to your IP via IAP.**

```bash
# HTTPS + HTTP (HTTP only redirects to HTTPS / serves ACME challenge)
gcloud compute firewall-rules create notera-allow-web \
  --allow=tcp:80,tcp:443 --target-tags=notera-web --direction=INGRESS

# SSH: do NOT open 22 to the world. Use IAP tunneling instead:
gcloud compute firewall-rules create notera-allow-iap-ssh \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=notera-web
# Then connect with:  gcloud compute ssh $VM_NAME --zone $ZONE --tunnel-through-iap
```

Postgres port **5432 is never opened** — it's only reachable inside the Docker network. That's the whole point of co‑location.

---

## 4. Part B — Harden the OS

SSH in (`gcloud compute ssh "$VM_NAME" --zone "$ZONE" --tunnel-through-iap`) and run:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install ufw fail2ban unattended-upgrades

# Automatic security patches
sudo dpkg-reconfigure -plow unattended-upgrades

# Host firewall (defence in depth on top of the GCP firewall)
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable

# fail2ban protects SSH from brute force
sudo systemctl enable --now fail2ban

# Create a non-root deploy user
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy
```

Disable password SSH (key/IAP only) in `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`, then `sudo systemctl restart ssh`.

---

## 5. Part C — Install Docker + Compose

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy            # log out/in for group to apply
docker compose version                    # confirm Compose v2
```

---

## 6. Part D — PostgreSQL on the same instance

You already ship `db/docker-compose.postgres.yml` (Postgres 18 + a `pg-backup` sidecar). In production we (1) keep it on an **encrypted volume**, (2) **do not publish 5432 to the host**, (3) enable **TLS + pgaudit**, and (4) ship dumps to **GCS**.

Key production edits to the Postgres service:

```yaml
services:
  postgres:
    image: postgres:18
    restart: unless-stopped
    # REMOVE the "ports: 5432:5432" mapping in prod — keep it on the internal network only.
    environment:
      POSTGRES_DB: notera
      POSTGRES_USER: notera_admin
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      TZ: UTC
    command:
      - "postgres"
      - "-c=shared_preload_libraries=pgaudit"   # audit logging for HIPAA
      - "-c=ssl=on"
      - "-c=ssl_cert_file=/certs/server.crt"
      - "-c=ssl_key_file=/certs/server.key"
      - "-c=log_connections=on"
      - "-c=log_disconnections=on"
    secrets: [pg_password]
    volumes:
      - pgdata:/var/lib/postgresql
      - ./init:/docker-entrypoint-initdb.d:ro
      - ./certs:/certs:ro
    networks: [notera_net]
```

**Backups to GCS** (replace the sidecar's local‑only dump). Create a bucket with versioning + retention, then a nightly cron on the host:

```bash
gsutil mb -l "$REGION" -b on "gs://${PROJECT_ID}-notera-backups"
gsutil versioning set on "gs://${PROJECT_ID}-notera-backups"

# /etc/cron.d/notera-backup  (2am daily)
0 2 * * * deploy docker exec notera-postgres pg_dump -U notera_admin -Fc notera \
  | gzip | gsutil cp - "gs://notera-prod-notera-backups/notera-$(date +\%F).sql.gz"
```

Run a **restore drill quarterly** (Part L) — a backup you've never restored is not a backup.

Apply the app schemas after the DB is up:

```bash
npm run db:reset          # or run db/schema.lab.sql + db/schema.upgrader.sql explicitly
npm run db:upgrader
```

---

## 7. Part E — App services (production Compose)

Create `docker-compose.prod.yml` at the repo root that runs web, backend, ner, postgres, and Caddy together. Build the Node apps from a multi‑stage Dockerfile (`turbo prune` keeps images small); the NER image already has a Dockerfile in `ner/`.

```yaml
name: notera
services:
  backend:
    build: { context: ., dockerfile: packages/backend/Dockerfile }
    env_file: [./.env.production]
    environment:
      DATABASE_URL: postgres://notera_admin@postgres:5432/notera
      NER_URL: http://ner:8000
      NODE_ENV: production
    depends_on: { postgres: { condition: service_healthy } }
    networks: [notera_net]
    restart: unless-stopped

  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    environment:
      NODE_ENV: production
      BACKEND_URL: http://backend:8080     # next.config rewrite target /backend/* → backend
    depends_on: [backend]
    networks: [notera_net]
    restart: unless-stopped

  ner:
    build: { context: ./ner }
    networks: [notera_net]
    restart: unless-stopped

  postgres:   # (from Part D)
    # ...

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [web, backend]
    networks: [notera_net]
    restart: unless-stopped

networks: { notera_net: {} }
volumes: { pgdata: {}, caddy_data: {} }
secrets:
  pg_password: { file: ./db/secrets/pg_password }
```

Bring it up: `docker compose -f docker-compose.prod.yml up -d --build`.

---

## 8. Part F — Reverse proxy + automatic TLS (Caddy)

Caddy gets and renews Let's Encrypt certificates automatically — no manual cert wrangling. Point your domain's A record at `$STATIC_IP` first, then:

```
# ./Caddyfile
app.notera.health {
    encode gzip
    # API + backend routes proxied straight to Express
    handle /backend/* {
        reverse_proxy backend:8080
    }
    handle /api/* {
        reverse_proxy backend:8080
    }
    # everything else → Next.js
    handle {
        reverse_proxy web:3000
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }
}
```

That gives you HTTPS, HSTS, and sane security headers out of the box.

---

## 9. Part G — Self‑hosted email + password authentication (built by you)

You already have the hard part: **`packages/backend/src/admin/session.js`** issues and verifies HMAC‑signed stateless cookies. We extend that from a single admin secret into a real **multi‑user email/password system** — no Firebase, no Auth0, fully owned by you.

### 9.1 Database — users, resets, audit

Add `db/schema.auth.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE NOT NULL,
  password_hash  text   NOT NULL,          -- bcrypt/argon2id, never plaintext
  full_name      text,
  role           text   NOT NULL DEFAULT 'clinician',   -- clinician | admin
  is_active      boolean NOT NULL DEFAULT true,
  failed_logins  int    NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.password_resets (
  token_hash  text PRIMARY KEY,            -- store only the HASH of the reset token
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false
);

-- HIPAA audit trail: who did what, when, from where
CREATE TABLE IF NOT EXISTS auth.audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  action     text NOT NULL,               -- login, logout, note_view, note_export, ...
  detail     jsonb,
  ip         inet,
  at         timestamptz NOT NULL DEFAULT now()
);
```

Enable `citext` (case‑insensitive email) and `pgcrypto` once: `CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;`.

### 9.2 User store — `packages/backend/src/auth/users.js`

```js
'use strict';
import bcrypt from 'bcrypt';           // add to backend deps: npm i bcrypt
import { pool } from '../db/pool.js';

const ROUNDS = 12;

export async function createUser({ email, password, fullName, role = 'clinician' }) {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('invalid email');
  if (String(password).length < 12) throw new Error('password must be ≥ 12 chars');
  const hash = await bcrypt.hash(password, ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO auth.users (email, password_hash, full_name, role)
     VALUES ($1,$2,$3,$4) RETURNING id, email, role`,
    [email.toLowerCase(), hash, fullName || null, role]);
  return rows[0];
}

export async function verifyLogin(email, password) {
  const { rows } = await pool.query(
    `SELECT * FROM auth.users WHERE email=$1 AND is_active=true`, [email.toLowerCase()]);
  const u = rows[0];
  if (!u) { await bcrypt.compare(password, '$2b$12$invalidinvalidinvalidinvalidinva'); return null; } // constant-time-ish
  if (u.locked_until && u.locked_until > new Date()) throw new Error('account locked — try later');
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    const fails = u.failed_logins + 1;
    const lock = fails >= 5 ? "now() + interval '15 minutes'" : 'NULL';
    await pool.query(`UPDATE auth.users SET failed_logins=$1, locked_until=${lock} WHERE id=$2`, [fails, u.id]);
    return null;
  }
  await pool.query(`UPDATE auth.users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
  return { id: u.id, email: u.email, role: u.role, fullName: u.full_name };
}

export async function audit(userId, action, detail, ip) {
  await pool.query(`INSERT INTO auth.audit_log (user_id, action, detail, ip) VALUES ($1,$2,$3,$4)`,
    [userId || null, action, detail ? JSON.stringify(detail) : null, ip || null]);
}
```

### 9.3 Extend the session cookie to carry the user

`session.js` already signs an arbitrary payload. Change `issue()` to embed the user, and add a helper that reads it:

```js
// in makeSession(): issue now takes the user
issue(user, ttlMs = TTL_DAYS * 86400000) {
  const payload = b64(JSON.stringify({ uid: user.id, email: user.email, role: user.role,
                                       exp: Date.now() + ttlMs, iat: Date.now(), v: 2 }));
  return `${payload}.${sign(payload)}`;
},
```

Everything else (HMAC verify, sliding refresh, HttpOnly/SameSite cookie) already works — you inherit it for free. Keep `ADMIN_SESSION_SECRET` in Secret Manager (Part I), 32+ random bytes.

### 9.4 Auth routes — `packages/backend/src/auth/authRoutes.js`

```js
import { createUser, verifyLogin, audit } from './users.js';
import { makeSession } from '../admin/session.js';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { sendMail } from './mailer.js';

export function mountAuth(app, dataDir) {
  const S = makeSession(dataDir);

  app.post('/api/auth/login', express.json(), async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const user = await verifyLogin(email, password);
      if (!user) { await audit(null, 'login_failed', { email }, req.ip); return res.status(401).json({ error: 'invalid credentials' }); }
      await audit(user.id, 'login', null, req.ip);
      res.setHeader('Set-Cookie', S.cookie(S.issue(user)));
      res.json({ ok: true, user });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/auth/logout', (req, res) => { res.setHeader('Set-Cookie', S.clearCookie()); res.json({ ok: true }); });

  app.get('/api/auth/me', (req, res) => {
    const tok = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(S.COOKIE + '='));
    const payload = tok && S.verify(tok.split('=')[1]);
    if (!payload) return res.status(401).json({ error: 'unauthenticated' });
    res.json({ user: { id: payload.uid, email: payload.email, role: payload.role } });
  });

  // Admin-only: create clinician accounts (protect with requireRole('admin'))
  app.post('/api/auth/users', requireRole('admin'), express.json(), async (req, res) => {
    try { res.json(await createUser(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Password reset (email a single-use token; store only its hash)
  app.post('/api/auth/request-reset', express.json(), async (req, res) => {
    const { email } = req.body || {};
    const { rows } = await pool.query(`SELECT id FROM auth.users WHERE email=$1`, [String(email||'').toLowerCase()]);
    if (rows[0]) {
      const token = crypto.randomBytes(32).toString('base64url');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      await pool.query(`INSERT INTO auth.password_resets (token_hash, user_id, expires_at)
                        VALUES ($1,$2, now() + interval '1 hour')`, [hash, rows[0].id]);
      await sendMail(email, 'Reset your Notera password',
        `Reset link: https://app.notera.health/reset?token=${token}\nExpires in 1 hour.`);
    }
    res.json({ ok: true }); // always 200 — never reveal whether the email exists
  });
}

// middleware
export function requireAuth(dataDir) {
  const S = makeSession(dataDir);
  return (req, res, next) => {
    const tok = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(S.COOKIE + '='));
    const p = tok && S.verify(tok.split('=')[1]);
    if (!p) return res.status(401).json({ error: 'unauthenticated' });
    req.user = { id: p.uid, email: p.email, role: p.role };
    next();
  };
}
export function requireRole(role) {
  return (req, res, next) => (req.user && (req.user.role === role || req.user.role === 'admin'))
    ? next() : res.status(403).json({ error: 'forbidden' });
}
```

Wire `requireAuth(dataDir)` in front of **every** PHI route in your Express app (the pipeline/run/results/patients endpoints in `packages/backend/src/admin/handler.js`), so no note can be generated or read without a valid session.

### 9.5 Transactional email — `packages/backend/src/auth/mailer.js`

Use SMTP you control (or a provider). Auth emails (reset links, invites) are **not** PHI, so a standard provider is fine — but never put patient content in email.

```js
import nodemailer from 'nodemailer';   // npm i nodemailer
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
export const sendMail = (to, subject, text) =>
  t.sendMail({ from: process.env.SMTP_FROM || 'no-reply@notera.health', to, subject, text });
```

### 9.6 Auth modules checklist

| Module | File | Purpose |
|---|---|---|
| User store | `auth/users.js` | bcrypt hashing, create/verify, lockout after 5 fails |
| Session | `admin/session.js` (extended) | HMAC cookie carrying `{uid,email,role}` |
| Routes | `auth/authRoutes.js` | login / logout / me / create‑user / reset |
| Middleware | `requireAuth`, `requireRole` | gate every PHI endpoint |
| Mailer | `auth/mailer.js` | reset links & invites via SMTP |
| Schema | `db/schema.auth.sql` | users, password_resets, audit_log |
| Frontend | `apps/web` login page | posts to `/api/auth/login`, reads `/api/auth/me` |

**Recommended add‑ons for "industry ready":** enforce a password policy (≥12 chars, breached‑password check via k‑anonymity HIBP API), optional **TOTP MFA** (`otplib`) for admins, session idle timeout (you already have sliding expiry), and rate‑limit `/api/auth/login` (`express-rate-limit`).

---

## 10. Part I — Secrets & Google API access

Never commit secrets. Use **Google Secret Manager** and pull them at deploy time into `.env.production` (perms `600`, owned by `deploy`).

```bash
echo -n "$(openssl rand -hex 32)" | gcloud secrets create ADMIN_SESSION_SECRET --data-file=-
gcloud secrets create DEEPSEEK_API_KEY --data-file=- <<< "sk-..."
# retrieve at deploy:
gcloud secrets versions access latest --secret=ADMIN_SESSION_SECRET
```

**Service account for Google APIs** (Speech, GCS, Vertex) — least privilege, key mounted into the backend container:

```bash
gcloud iam service-accounts create notera-runtime
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:notera-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/speech.client"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:notera-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:notera-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"          # Vertex AI Gemini
gcloud iam service-accounts keys create sa-key.json \
  --iam-account="notera-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
# mount sa-key.json into backend; set GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa-key.json
```

---

## 11. Part J — HIPAA / compliance checklist

- [ ] **BAA signed** with Google Cloud, before any real PHI.
- [ ] Use only **BAA‑covered services**: Compute Engine, Cloud Storage, Speech‑to‑Text, **Vertex AI (Gemini)**, Cloud KMS, Secret Manager, Cloud Logging. **Route Gemini through Vertex AI**, not the public Gemini API key — set `GEMINI_MODEL`/provider to the Vertex endpoint. **Disable DeepSeek in production** (`HALLUCINATION_REMOVER` uses Gemini already; Second Opinion → keep off for real PHI unless separately covered).
- [ ] **Encryption at rest**: default on for disks + GCS; use **CMEK** (Cloud KMS) for stronger control.
- [ ] **Encryption in transit**: TLS everywhere (Caddy for public, `ssl=on` for Postgres, HTTPS to Google APIs).
- [ ] **Access control**: unique per‑clinician logins (Part G), role‑based routes, no shared accounts.
- [ ] **Audit logging**: `auth.audit_log` for app events + Cloud Audit Logs + pgaudit for DB. Retain per your policy (commonly 6 years).
- [ ] **Minimum necessary / de‑identification**: your pipeline already de‑identifies; keep the de‑id step on the ingest path.
- [ ] **Backups + tested restore** (Part L); **breach response plan** documented.
- [ ] **VM hardening** (Part B), automatic patching, no public DB port.

> Compliance is process + technology. This guide covers the technology; you still need policies, workforce training, and a risk assessment. Have a HIPAA consultant review before treating live patients.

---

## 12. Part K — Monitoring, logging, alerting

Install the **Ops Agent** for metrics + logs into Cloud Monitoring:

```bash
curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent.sh
sudo bash add-google-cloud-ops-agent.sh --also-install
```

Then in Cloud Monitoring create: an **uptime check** on `https://app.notera.health/api/health`, and **alert policies** for CPU > 85% (5 min), disk > 80%, memory > 90%, and any container restart loop. Ship Docker/app logs with the Ops Agent's Docker plugin or Caddy/JSON logs. Add a lightweight `/api/health` route in Express that pings Postgres (`SELECT 1`) and returns 200.

---

## 13. Part L — Backups & disaster recovery

- **DB**: nightly `pg_dump -Fc` → GCS (Part D), 30–90 day retention, bucket versioning on.
- **Disk snapshots**: schedule daily Compute Engine snapshots of the boot disk.
  ```bash
  gcloud compute resource-policies create snapshot-schedule notera-daily \
    --region="$REGION" --max-retention-days=14 --daily-schedule --start-time=03:00
  gcloud compute disks add-resource-policies "$VM_NAME" --zone="$ZONE" --resource-policies=notera-daily
  ```
- **Restore drill (quarterly)**: spin a scratch VM, `gsutil cp` the latest dump, `pg_restore`, verify row counts + a sample note. Record RTO/RPO.
- **RPO** ≈ 24 h (nightly). Tighten to minutes later with WAL archiving / Cloud SQL if needed.

---

## 14. Part M — Deploy workflow & scaling out

**Deploy** (simple, reliable): build images in CI (GitHub Actions → Artifact Registry), then on the VM `docker compose pull && docker compose up -d && npm run db:upgrader`. For **zero‑downtime**, Caddy keeps serving the old container until the new one is healthy (add `healthcheck` to web/backend).

**When one VM isn't enough**, graduate without rewriting: move Postgres to **Cloud SQL for PostgreSQL** (managed backups + HA failover), containerize web/backend to **Cloud Run** (autoscaling, scale‑to‑zero), keep NER on Cloud Run too, and front it with a **Global External Load Balancer** + Cloud Armor (WAF). Your auth module and schema move as‑is because they're just Postgres + stateless cookies.

---

## 15. Part N — Rough monthly cost (verify current pricing)

| Item | Est. / month (USD) |
|---|---|
| `e2-standard-4` VM (sustained use) | ~$100–130 |
| 100 GB SSD + snapshots | ~$20 |
| Static IP | ~$3 |
| GCS backups (tens of GB) | ~$1–5 |
| Speech‑to‑Text | usage‑based (per audio minute) |
| Vertex AI Gemini | usage‑based (per token) |
| **Fixed infra subtotal** | **~$125–160 + usage** |

LLM + ASR are the variable costs; everything else is predictable. Confirm live prices in the GCP pricing calculator for your region.

---

## 16. Part O — Go‑live checklist

- [ ] BAA signed; only BAA‑covered services enabled; DeepSeek off for real PHI.
- [ ] VM hardened (Parts A–B); SSH via IAP only; 5432 not public.
- [ ] Postgres on encrypted volume, TLS + pgaudit on, nightly GCS backups + a **successful restore test**.
- [ ] Caddy serving HTTPS with HSTS; security headers present.
- [ ] Auth module deployed: users table, login/logout/reset, lockout, audit log; **every PHI route behind `requireAuth`**.
- [ ] Secrets in Secret Manager; `.env.production` is `600`; no secrets in git.
- [ ] Ops Agent + uptime check + alert policies live; `/api/health` returns 200.
- [ ] Disk snapshot schedule active; DR runbook written.
- [ ] First admin user created; clinician onboarding tested end‑to‑end (login → record → generate note → export).

---

### Appendix — `.env.production` keys to set

```
NODE_ENV=production
DATABASE_URL=postgres://notera_admin@postgres:5432/notera
PGSSLMODE=require
ADMIN_SESSION_SECRET=<from Secret Manager, 32+ bytes>
ADMIN_SESSION_TTL_DAYS=7
GOOGLE_APPLICATION_CREDENTIALS=/secrets/sa-key.json
GEMINI_PROVIDER=vertex            # route Gemini via Vertex AI (HIPAA), not the public API key
GCP_PROJECT=notera-prod
GCP_LOCATION=us-central1
SPEECH_LANGUAGE=en-US
GCS_AUDIO_BUCKET=notera-prod-audio
NER_URL=http://ner:8000
HALLUCINATION_REMOVER=1
# Second Opinion (DeepSeek) — leave UNSET/disabled for real PHI:
# DEEPSEEK_API_KEY=
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=<from Secret Manager>
SMTP_FROM=no-reply@notera.health
```
