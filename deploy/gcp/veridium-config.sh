#!/bin/bash
# Applies Veridium's settings from instance metadata, so changing them never needs SSH:
#   veridium-riot-api-key   RIOT_API_KEY (dev keys expire daily: update this one)
#   veridium-site-password  SITE_PASSWORD (whole-site password; keep it set until launch)
#   veridium-contact-email  CONTACT_EMAIL (shown on the Privacy Policy and Terms)
#   veridium-admin-emails   ADMIN_EMAILS (your account email(s): Veridium staff, can verify organizations)
#   veridium-domain         the site's hostname for HTTPS (default: <external-ip>.sslip.io)
#   veridium-branch         branch to run (default: main)
#   veridium-deploy         change it (e.g. to a timestamp) to pull the latest code and restart
#
#   veridium-config --once  write /etc/veridium/veridium.env and the Caddyfile, then exit (used at boot)
#   veridium-config         keep watching metadata; on any change rewrite the env file and
#                           restart the app, and deploy new code when the branch or deploy value changes
set -euo pipefail

CONF=${VERIDIUM_CONF:-/etc/veridium}  # override only in tests
ENV_FILE=$CONF/veridium.env
CADDYFILE=${VERIDIUM_CADDYFILE:-/etc/caddy/Caddyfile}  # override only in tests
URL=${VERIDIUM_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1/instance/attributes/}  # override only in tests
md() { curl -fsS -H 'Metadata-Flavor: Google' "$URL$1" 2>/dev/null || true; }

# systemd EnvironmentFile value in single quotes (taken literally). A value can't itself contain a
# single quote or a newline. If one does, nothing is written: the previous env file stays (or, on
# first boot, there's none and the app doesn't start), so a bad password never means *no* password.
quoted() {
  local v; v=$(md "$1")
  if [[ "$v" == *"'"* || "$v" == *$'\n'* ]]; then
    logger -t veridium-config "$1 contains a quote or newline: settings NOT applied, please change it"
    return 1
  fi
  printf "'%s'" "$v"
}

write_env() {
  local tmp riot site contact admins
  riot=$(quoted veridium-riot-api-key) && site=$(quoted veridium-site-password) && contact=$(quoted veridium-contact-email) \
    && admins=$(quoted veridium-admin-emails) || return 1
  tmp=$(mktemp "$CONF/.env.XXXXXX")
  chmod 600 "$tmp"   # secrets: readable by root only (systemd reads it before dropping privileges)
  {
    echo "NODE_ENV=production"
    echo "HOST=127.0.0.1"   # only Caddy, on the same machine, talks to the app
    echo "PORT=3000"
    echo "DB_PATH=/var/lib/veridium/veridium.db"
    echo "SEASONS=3"
    echo "RIOT_API_KEY=$riot"
    echo "SITE_PASSWORD=$site"
    echo "CONTACT_EMAIL=$contact"
    echo "ADMIN_EMAILS=$admins"
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# The public hostname: veridium-domain if set, else <external-ip>.sslip.io (a free DNS name that
# resolves to the IP inside it, so Caddy can get a real certificate without owning a domain).
site_host() {
  local domain ip
  domain=$(md veridium-domain)
  if [ -z "$domain" ]; then
    ip=$(curl -fsS -H 'Metadata-Flavor: Google' "${URL%attributes/}network-interfaces/0/access-configs/0/external-ip" 2>/dev/null || true)
    [ -n "$ip" ] && domain="${ip//./-}.sslip.io"
  fi
  [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] && printf '%s' "${domain,,}"
}

# Caddy terminates HTTPS (automatic Let's Encrypt/ZeroSSL certificate), redirects HTTP to HTTPS and
# forwards to the app. Returns 0 if the file changed (so the caller reloads Caddy), 1 if not or on error.
write_caddyfile() {
  local host contact tmp
  host=$(site_host) || { logger -t veridium-config "no valid hostname (veridium-domain invalid, or no external IP yet): Caddyfile unchanged"; return 1; }
  contact=$(md veridium-contact-email)
  [[ "$contact" =~ ^[^[:space:]\"{}]+@[^[:space:]\"{}]+$ ]] || contact=""
  tmp=$(mktemp)
  {
    echo "# Written by veridium-config from the VM's metadata. Changes here are overwritten."
    [ -n "$contact" ] && printf '{\n\temail %s\n}\n\n' "$contact"
    echo "$host {"
    echo "	encode gzip"
    echo "	header Strict-Transport-Security \"max-age=86400\""
    echo "	reverse_proxy 127.0.0.1:3000"
    echo "}"
  } > "$tmp"
  if [ -f "$CADDYFILE" ] && cmp -s "$tmp" "$CADDYFILE"; then rm -f "$tmp"; return 1; fi
  mkdir -p "$(dirname "$CADDYFILE")"
  chmod 644 "$tmp"; mv "$tmp" "$CADDYFILE"
  logger -t veridium-config "Caddyfile written for https://$host"
  return 0
}

mkdir -p "$CONF"
if [ "${1:-}" = "--once" ]; then
  write_caddyfile || true
  write_env
  exit $?
fi

# Long-poll the metadata server: it answers when any attribute changes (or after the timeout).
etag=NONE
last_code="$(md veridium-branch)|$(md veridium-deploy)"
while true; do
  headers=$(mktemp)
  if curl -fsS -D "$headers" -o /dev/null -H 'Metadata-Flavor: Google' \
      "$URL?recursive=true&wait_for_change=true&timeout_sec=300&last_etag=$etag"; then
    new_etag=$(awk -F': ' 'tolower($1)=="etag" {print $2}' "$headers" | tr -d '\r')
    if [ -n "$new_etag" ] && [ "$new_etag" != "$etag" ]; then
      if [ "$etag" != NONE ]; then
        code="$(md veridium-branch)|$(md veridium-deploy)"
        if [ "$code" != "$last_code" ]; then
          logger -t veridium-config "branch/deploy changed: deploying"
          /usr/local/bin/veridium-deploy || logger -t veridium-config "deploy failed; still running the previous code"
          last_code=$code
        fi
        if write_env; then
          systemctl restart veridium.service
          logger -t veridium-config "settings changed: env rewritten, app restarted"
        fi
        if write_caddyfile; then systemctl reload caddy.service || systemctl restart caddy.service; fi
      fi
      etag=$new_etag
    fi
  else
    sleep 10
  fi
  rm -f "$headers"
done
