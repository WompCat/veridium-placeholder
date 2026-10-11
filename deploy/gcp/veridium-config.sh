#!/bin/bash
# Applies Veridium's settings from instance metadata, so changing them never needs SSH:
#   veridium-riot-api-key   RIOT_API_KEY (dev keys expire daily: update this one)
#   veridium-site-password  SITE_PASSWORD (whole-site password; keep it set until launch)
#   veridium-contact-email  CONTACT_EMAIL (shown on the Privacy Policy and Terms)
#   veridium-branch         branch to run (default: main)
#   veridium-deploy         change it (e.g. to a timestamp) to pull the latest code and restart
#
#   veridium-config --once  write /etc/veridium/veridium.env and exit (used at boot)
#   veridium-config         keep watching metadata; on any change rewrite the env file and
#                           restart the app, and deploy new code when the branch or deploy value changes
set -euo pipefail

CONF=${VERIDIUM_CONF:-/etc/veridium}  # override only in tests
ENV_FILE=$CONF/veridium.env
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
  local tmp riot site contact
  riot=$(quoted veridium-riot-api-key) && site=$(quoted veridium-site-password) && contact=$(quoted veridium-contact-email) || return 1
  tmp=$(mktemp "$CONF/.env.XXXXXX")
  chmod 600 "$tmp"   # secrets: readable by root only (systemd reads it before dropping privileges)
  {
    echo "NODE_ENV=production"
    echo "HOST=0.0.0.0"
    echo "PORT=80"
    echo "DB_PATH=/var/lib/veridium/veridium.db"
    echo "SEASONS=3"
    echo "RIOT_API_KEY=$riot"
    echo "SITE_PASSWORD=$site"
    echo "CONTACT_EMAIL=$contact"
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

mkdir -p "$CONF"
if [ "${1:-}" = "--once" ]; then
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
      fi
      etag=$new_etag
    fi
  else
    sleep 10
  fi
  rm -f "$headers"
done
