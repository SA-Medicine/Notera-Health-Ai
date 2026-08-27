# Cloudflare Setup — proper WAF/edge protection for Notera

Goal: put **Cloudflare in front of everything** — the marketing site + app (Cloudflare Pages) and the **API on the GCP VM (orange‑cloud proxied)** — so you get the free WAF, DDoS protection, rate limiting, and TLS, **and** make it impossible to bypass by hitting the VM's IP directly.

> The single most important step is **§4 (lock the origin firewall to Cloudflare IPs)**. Orange‑cloud alone does nothing if an attacker can still reach the VM's public IP directly.

---

## 1. DNS records (Cloudflare dashboard → DNS)

Use Cloudflare as your DNS provider for `aitoolsfordoctor.com`, then:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` (apex) | your Pages project | 🟠 Proxied |
| CNAME | `www` | your Pages project | 🟠 Proxied |
| CNAME | `app` | your Pages project | 🟠 Proxied |
| A | `api` | `<GCP VM static IP>` | 🟠 **Proxied** |

The apex/`www`/`app` records are added automatically when you attach custom domains to the Pages project. `api` you add manually and **must be Proxied** (orange) for the WAF to apply.

---

## 2. SSL/TLS mode → Full (strict)

Cloudflare dashboard → **SSL/TLS → Overview → Full (strict)**. This encrypts both hops (browser↔Cloudflare and Cloudflare↔origin) and *verifies* the origin certificate — the correct, secure mode. Also enable:

- **Edge Certificates:** Always Use HTTPS = On; Minimum TLS = 1.2; TLS 1.3 = On; HTTP/3 = On; Automatic HTTPS Rewrites = On.
- **HSTS** = On (6 months, includeSubDomains) — Caddy already sends it too.

## 3. Origin Certificate for the API VM (so Full‑strict works)

Because the API is orange‑clouded, Caddy can't do the normal Let's Encrypt HTTP challenge. Use a **Cloudflare Origin Certificate** instead (free, 15‑year):

1. Dashboard → **SSL/TLS → Origin Server → Create Certificate** (default RSA, hostnames `api.aitoolsfordoctor.com`).
2. Save the two blocks on the VM:
   ```bash
   mkdir -p certs
   nano certs/origin.pem     # paste the "Origin Certificate"
   nano certs/origin.key     # paste the "Private Key"
   chmod 600 certs/origin.key
   ```
3. The provided `Caddyfile` already points at `./certs/origin.pem` + `./certs/origin.key`, and `docker-compose.prod.yml` mounts `./certs` into Caddy. Restart: `docker compose -f docker-compose.prod.yml up -d caddy`.

## 4. Lock the origin firewall to Cloudflare IPs (critical) 🔒

Prevents anyone from bypassing the WAF by hitting the VM IP directly:

```bash
bash scripts/gcp-firewall-cloudflare.sh
```

This creates a GCP rule allowing **tcp:443 only from Cloudflare's IP ranges** (fetched live) and deletes the world‑open web rule. SSH stays on the IAP‑only rule. After this, `curl https://<VM-IP>` from anywhere but Cloudflare fails — exactly what you want.

## 5. Authenticated Origin Pulls (mTLS) — belt + suspenders

Makes the origin refuse any TLS connection that doesn't present Cloudflare's client certificate (a second, cryptographic guarantee that traffic came through Cloudflare):

1. Dashboard → **SSL/TLS → Origin Server → Authenticated Origin Pulls = On** (zone‑level).
2. Put Cloudflare's origin‑pull CA on the VM as `certs/cf-origin-pull-ca.pem` (Cloudflare publishes this PEM in their Authenticated Origin Pulls docs).
3. **Uncomment the `client_auth { … }` block** in the `Caddyfile`, then `docker compose up -d caddy`.

## 6. WAF & rate limiting (Security → WAF)

- **Managed rules:** enable the **Cloudflare Managed Ruleset** and **OWASP Core Ruleset** (both free) on the zone.
- **Bot Fight Mode:** Security → Bots → On (free tier).
- **Rate‑limit the login** (brute‑force protection at the edge). Security → WAF → **Rate limiting rules → Create**:
  - **If** `(http.host eq "app.aitoolsfordoctor.com" and http.request.uri.path eq "/backend/api/auth/login")`
  - **Rate:** 10 requests per 1 minute, **per IP**
  - **Action:** Managed Challenge (or Block) for 10 minutes.
  > Rate‑limit at the **app** host + `/backend/api/auth/login` path, because that's what the browser actually requests (the `/backend/*` proxy forwards it server‑side to the API). Your backend also locks accounts after 5 failed passwords — two independent layers.
- **Optional — password reset abuse:** same rule for `/backend/api/auth/request-reset` (e.g., 5/min per IP).
- **Optional — geo restriction:** if you only serve one country, add a custom rule to challenge traffic from others.

## 7. Cache rules (Rules → Caching)

- **API + app must NOT be cached** (dynamic/authenticated). Cloudflare bypasses cache for these by default, but to be explicit add a rule: `http.host in {"api.aitoolsfordoctor.com" "app.aitoolsfordoctor.com"}` → **Bypass cache**.
- **Marketing (apex/www) should be cached** aggressively: `http.host in {"aitoolsfordoctor.com" "www.aitoolsfordoctor.com"}` → Cache Everything, Edge TTL a few hours. This makes the SEO site fast worldwide for free.

## 8. Pages (frontend) hardening

Cloudflare Pages already sits behind Cloudflare, so the WAF/DDoS/bot rules above cover the marketing site + app too. Just make sure the custom domains (`aitoolsfordoctor.com`, `www`, `app`) are attached to the Pages project and proxied.

---

## Verification checklist

- [ ] `api` DNS record is 🟠 Proxied; SSL mode = **Full (strict)**.
- [ ] Origin Certificate installed in Caddy; `https://api.aitoolsfordoctor.com/healthz` returns `{"ok":true}`.
- [ ] `scripts/gcp-firewall-cloudflare.sh` run → hitting the raw VM IP on 443 **times out**; only Cloudflare reaches it.
- [ ] (Optional) Authenticated Origin Pulls on + Caddy `client_auth` uncommented.
- [ ] Managed WAF ruleset + Bot Fight Mode on; login rate‑limit rule active.
- [ ] Cache: bypass for `api`/`app`, cache for the marketing apex.
- [ ] Real client IP reaches the backend (Caddy `trusted_proxies` + `CF-Connecting-IP`) → your `auth.audit_log` shows real IPs, not Cloudflare's.
