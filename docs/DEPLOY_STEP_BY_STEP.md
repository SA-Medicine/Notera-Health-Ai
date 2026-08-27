# Notera — Beginner Deployment Walkthrough (where do I type this?)

This is the "explain it like it's my first deploy" version. Every command block is tagged with **WHERE** to run it. You do **not** need to install anything on your Windows PC — you'll use Google Cloud Shell (a terminal in your browser).

## The 3 places you'll work

| Tag | Where | How you get there |
|---|---|---|
| 🟦 **Cloud Shell** | A Linux terminal in your browser, `gcloud` pre‑installed | console.cloud.google.com → click the `>_` icon (top‑right) |
| 🟩 **VM** | A terminal *inside your server*, reached from Cloud Shell | you run one SSH command from Cloud Shell (Step 4) |
| 🟧 **Cloudflare** | Point‑and‑click dashboard, no terminal | dash.cloudflare.com |

When you see 🟦, type it in Cloud Shell. When you see 🟩, you must already be SSH'd into the VM. 🟧 means click around the Cloudflare website.

---

## Step 0 — Put your code on GitHub (one time)

The server and Cloudflare both pull your code from a Git repo, so it needs to be on GitHub (private is fine — your secrets are git‑ignored, so they won't be uploaded).

On your Windows PC, in the project folder (PowerShell or Git Bash), if it isn't already on GitHub:

```bash
git add -A && git commit -m "deploy config"
git remote add origin https://github.com/<you>/notera.git   # skip if already added
git push -u origin main
```

Copy that repo URL — you'll paste it in Step 4.

---

## Step 1 — Open Google Cloud & Cloud Shell

1. Go to **https://console.cloud.google.com** and sign in.
2. At the very top, make sure the project selector shows **`medproject-506019`** (click it and pick that project if not).
3. Click the **`>_`** terminal icon in the top‑right toolbar. A black terminal panel opens at the bottom — that's **🟦 Cloud Shell**. If it asks to "Authorize", click Authorize.

Everything tagged 🟦 goes into that panel.

---

## Step 2 — Set up the project (🟦 Cloud Shell)

Paste these one block at a time:

```bash
export PROJECT_ID=medproject-506019
export REGION=us-central1 ZONE=us-central1-a
gcloud config set project $PROJECT_ID
gcloud services enable compute.googleapis.com aiplatform.googleapis.com iap.googleapis.com
```

Give your existing service account permission to call Vertex AI:

```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gcpdev@medproject-506019.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

---

## Step 3 — Create the server VM (🟦 Cloud Shell)

```bash
gcloud compute addresses create notera-ip --region=$REGION
export IP=$(gcloud compute addresses describe notera-ip --region=$REGION --format='value(address)')
echo "WRITE THIS DOWN → VM IP = $IP"

gcloud compute instances create notera-app \
  --zone=$ZONE --machine-type=e2-small \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --address=$IP \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --tags=notera-web

# firewall: allow SSH via Google IAP, and (temporarily) web ports so we can test
gcloud compute firewall-rules create notera-iap-ssh \
  --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=notera-web
gcloud compute firewall-rules create notera-web \
  --allow=tcp:80,tcp:443 --target-tags=notera-web
```

📝 **Save that IP address** — you'll type it into Cloudflare in Step 6.

---

## Step 4 — Get into the server (🟦 → 🟩)

Still in Cloud Shell, connect to the VM:

```bash
gcloud compute ssh notera-app --zone=$ZONE --tunnel-through-iap
```

The first time it may say "generating SSH key" — press Enter through the prompts (blank passphrase is fine). When the prompt changes to something like `you@notera-app:~$`, **you are now 🟩 on the VM.** Everything below tagged 🟩 goes here.

Install Docker and tools:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install ufw fail2ban unattended-upgrades git
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22,80,443/tcp && sudo ufw --force enable
sudo systemctl enable --now fail2ban
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```

That `exit` drops you back to 🟦 Cloud Shell (needed so Docker permissions apply). SSH back in:

```bash
gcloud compute ssh notera-app --zone=$ZONE --tunnel-through-iap
```

You're 🟩 on the VM again. Clone your code (paste your GitHub URL from Step 0):

```bash
git clone https://github.com/<you>/notera.git notera && cd notera
mkdir -p secrets db/secrets certs .data
```

---

## Step 5 — Create the secret files on the server (🟩 VM)

We generate the two passwords right here and paste your Google key. Copy‑paste this whole block:

```bash
# 1) random session secret + database password
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)" > /tmp/secret1
openssl rand -hex 24 > db/secrets/pg_password
```

Now create the Google service‑account key file. Type:

```bash
nano secrets/sa-key.json
```

Nano (a text editor) opens. **Paste the entire service‑account JSON** you have (the `{ "type": "service_account", ... }` block). Then press **Ctrl+O, Enter** to save and **Ctrl+X** to exit.

Now create the main config file:

```bash
nano .env.production
```

Paste this, then replace `PASTE_SESSION_SECRET_HERE` with the value shown by `cat /tmp/secret1` (run that in another moment), and set your real SMTP host:

```
NODE_ENV=production
PORT=8080
REQUIRE_AUTH=true
ENABLE_ADMIN=0
NER_DISABLED=1

ADMIN_SESSION_SECRET=PASTE_SESSION_SECRET_HERE
ADMIN_SESSION_TTL_DAYS=7
APP_URL=https://app.aitoolsfordoctor.com
CORS_ORIGIN=https://app.aitoolsfordoctor.com

DATABASE_URL=postgres://notera_admin@postgres:5432/notera

LLM_BACKEND=vertex
GCP_PROJECT=medproject-506019
VERTEX_LOCATION=global
GEMINI_MODEL=gemini-3.7-flash
GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/sa-key.json
GEMINI_MAX_OUTPUT_TOKENS=65536

SMTP_HOST=smtp.agilepartners-ai.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=support@agilepartners-ai.com
SMTP_PASS=P2ssw0rd!1234
SMTP_FROM=support@agilepartners-ai.com

HALLUCINATION_REMOVER=1
NORMALIZE_DEID_DATES=0
```

Save (Ctrl+O, Enter) and exit (Ctrl+X). Then fix the session secret line and lock permissions:

```bash
cat /tmp/secret1        # copy the value after the = sign
nano .env.production    # replace PASTE_SESSION_SECRET_HERE with it, save, exit
chmod 600 .env.production secrets/sa-key.json db/secrets/pg_password
rm /tmp/secret1
```

> Simpler alternative: you already generated these exact files on your Windows PC. If you'd rather upload them, in Cloud Shell click the **⋮ menu → Upload**, upload `.env.production`, `sa-key.json`, `pg_password`, then `gcloud compute scp` them to the VM. The nano method above avoids all that.

---

## Step 6 — Start everything + create your login (🟩 VM)

```bash
docker compose -f docker-compose.prod.yml up -d --build      # takes a few minutes the first time
docker compose -f docker-compose.prod.yml exec backend node /app/db/migrate_auth.mjs
docker compose -f docker-compose.prod.yml exec backend node /app/db/reset.mjs

# create YOUR admin account — pick a strong 12+ char password
docker compose -f docker-compose.prod.yml exec \
  -e ADMIN_EMAIL=you@aitoolsfordoctor.com -e ADMIN_PASSWORD='your-strong-password' \
  backend node /app/db/create_admin.mjs
```

The site won't answer on HTTPS yet — it needs the Cloudflare certificate (next step).

---

## Step 7 — Cloudflare: add your domain (🟧 dashboard)

1. Go to **https://dash.cloudflare.com** → **Add a site** → type `aitoolsfordoctor.com` → Free plan.
2. Cloudflare shows **two nameservers**. Go to wherever you bought the domain (your registrar), and set the domain's nameservers to those two. Wait until Cloudflare says **Active** (minutes to a few hours).

---

## Step 8 — Cloudflare: DNS + SSL + certificate (🟧 + 🟩)

**🟧 DNS tab:** add a record → Type **A**, Name **`api`**, IPv4 **= the VM IP from Step 3**, Proxy status **Proxied (orange cloud)**. Save.

**🟧 SSL/TLS → Overview:** set mode to **Full (strict)**.

**🟧 SSL/TLS → Origin Server → Create Certificate** (hostname `api.aitoolsfordoctor.com`). It shows an **Origin Certificate** and a **Private Key**. Keep this page open.

**🟩 On the VM**, paste them:

```bash
nano ~/notera/certs/origin.pem      # paste the "Origin Certificate", save+exit
nano ~/notera/certs/origin.key      # paste the "Private Key", save+exit
chmod 600 ~/notera/certs/origin.key
docker compose -f docker-compose.prod.yml up -d caddy
```

Test it: `curl https://api.aitoolsfordoctor.com/healthz` (run on the VM) should print `{"ok":true,...}`.

---

## Step 9 — Cloudflare: lock the server so only Cloudflare can reach it (🟦 Cloud Shell)

Back in **Cloud Shell** (open a new tab of it, or `exit` the VM first):

```bash
cd ~   # or wherever; the script only needs gcloud + curl
curl -fsSL https://raw.githubusercontent.com/<you>/notera/main/scripts/gcp-firewall-cloudflare.sh -o cf-fw.sh
bash cf-fw.sh
```

(Or just clone your repo in Cloud Shell and run `bash scripts/gcp-firewall-cloudflare.sh`.) This makes the API reachable **only** through Cloudflare's WAF.

---

## Step 10 — Cloudflare: turn on the WAF + rate limiting (🟧 dashboard)

- **Security → WAF → Managed rules:** enable the **Cloudflare Managed Ruleset**.
- **Security → Bots:** turn on **Bot Fight Mode**.
- **Security → WAF → Rate limiting rules → Create:** field = `URI Path`, condition = `equals /backend/api/auth/login`; also add hostname `equals app.aitoolsfordoctor.com`; rate **10 per 1 minute**, action **Managed Challenge**.

(Details/screically in `docs/CLOUDFLARE_SETUP.md`.)

---

## Step 11 — Deploy the website (frontend) on Cloudflare Pages (🟧 dashboard)

1. **Workers & Pages → Create → Pages → Connect to Git** → pick your `notera` repo.
2. Settings: **Root directory** `apps/web`; **Build command** `npx @cloudflare/next-on-pages`; **Output directory** `.vercel/output/static`.
3. **Environment variables** (add all three):
   - `BACKEND_URL` = `https://api.aitoolsfordoctor.com`
   - `NEXT_PUBLIC_SITE_URL` = `https://aitoolsfordoctor.com`
   - `NEXT_PUBLIC_APP_URL` = `https://app.aitoolsfordoctor.com`
4. Click **Save and Deploy**. When it finishes, open **Custom domains** on the Pages project and add: `aitoolsfordoctor.com`, `www.aitoolsfordoctor.com`, `app.aitoolsfordoctor.com` (Cloudflare adds the DNS automatically).

---

## Step 12 — Check it works 🎉

- Open **https://aitoolsfordoctor.com** → your marketing landing page.
- Open **https://app.aitoolsfordoctor.com** → the login screen. Log in with the admin email/password from Step 6.
- Once in, create a clinician user and generate a test note.

---

## If something breaks — quick checks

| Symptom | Do this (🟩 VM) |
|---|---|
| Site not loading | `docker compose -f docker-compose.prod.yml ps` — all "Up"? |
| Backend errors | `docker compose -f docker-compose.prod.yml logs backend --tail=50` |
| DB issues | `docker compose -f docker-compose.prod.yml logs postgres --tail=50` |
| Cert/HTTPS issues | `docker compose -f docker-compose.prod.yml logs caddy --tail=50` |
| Redeploy after code change | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |

## Still to do (yours)
- Confirm the real **SMTP host** for `agilepartners-ai.com` (Step 5) — ask your email provider.
- Add images to `apps/web/public/`: `og.png`, `icon-192.png`, `icon-512.png`, `favicon.ico`.
- **Rotate** the Google key + SMTP password you shared earlier.
- Set up the nightly database backup (see `docs/HOSTING_GCP_SELF_HOSTED.md`, Part L).
