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
V4="$(curl -fsSL https://www.cloudflare.com/ips-v4)"
V6="$(curl -fsSL https://www.cloudflare.com/ips-v6)"
RANGES="$(printf '%s\n%s\n' "$V4" "$V6" | grep -v '^$' | paste -sd, -)"
[ -n "$RANGES" ] || { echo "Could not fetch Cloudflare ranges"; exit 1; }

echo "Applying firewall rule notera-cf-https (443 ← Cloudflare only, tag=$TAG)…"
if gcloud compute firewall-rules describe notera-cf-https >/dev/null 2>&1; then
  gcloud compute firewall-rules update notera-cf-https --allow=tcp:443 --source-ranges="$RANGES"
else
  gcloud compute firewall-rules create notera-cf-https \
    --direction=INGRESS --action=ALLOW --allow=tcp:443 \
    --source-ranges="$RANGES" --target-tags="$TAG"
fi

# Remove the world-open web rule (80/443 to everyone). With an Origin Certificate,
# Caddy does NOT need port 80 (no ACME HTTP challenge), so we close it entirely.
gcloud compute firewall-rules delete notera-web --quiet 2>/dev/null || true

echo "✅ Origin now reachable ONLY via Cloudflare. Direct-IP access to the API is blocked."
echo "   (SSH stays on the IAP rule; nothing else is exposed.)"
