#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Lock the Notera VM so ONLY Cloudflare can reach the API (port 443).
# Without this, an attacker who learns the VM's IP can hit the origin directly
# and bypass the Cloudflare WAF/rate-limits entirely. Run AFTER the VM exists and
# api.aitoolsfordoctor.com is proxied (orange cloud) in Cloudflare.
#
#   bash scripts/gcp-firewall-cloudflare.sh
# Re-run whenever Cloudflare updates its IP ranges (rare).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TAG="${TARGET_TAG:-notera-web}"

echo "Fetching Cloudflare IP ranges…"
# GCP does NOT allow IPv4 and IPv6 in the same firewall rule → create TWO rules.
V4="$(curl -fsSL https://www.cloudflare.com/ips-v4 | grep -v '^$' | paste -sd, -)"
V6="$(curl -fsSL https://www.cloudflare.com/ips-v6 | grep -v '^$' | paste -sd, -)"
[ -n "$V4" ] || { echo "Could not fetch Cloudflare ranges"; exit 1; }

upsert() {  # name  ranges
  if gcloud compute firewall-rules describe "$1" >/dev/null 2>&1; then
    gcloud compute firewall-rules update "$1" --allow=tcp:443 --source-ranges="$2"
  else
    gcloud compute firewall-rules create "$1" \
      --direction=INGRESS --allow=tcp:443 --source-ranges="$2" --target-tags="$TAG"
  fi
}
echo "Applying firewall rules (443 ← Cloudflare only, tag=$TAG)…"
upsert notera-cf-https-v4 "$V4"
upsert notera-cf-https-v6 "$V6"

# Remove the world-open web rule (80/443 to everyone). With an Origin Certificate,
# Caddy does NOT need port 80 (no ACME HTTP challenge), so we close it entirely.
gcloud compute firewall-rules delete notera-web --quiet 2>/dev/null || true

echo "✅ Origin now reachable ONLY via Cloudflare. Direct-IP access to the API is blocked."
echo "   (SSH stays on the IAP rule; nothing else is exposed.)"
