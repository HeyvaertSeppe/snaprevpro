#!/usr/bin/env bash
# =============================================================================
# snaprevpro: add WebSocket support to the FastPanel site, safely.
#
# Run on the FastPanel server as root:
#   bash install-fastpanel.sh                      # defaults below
#   BACKEND=10.1.3.241:3080 DOMAIN=web.heyvaertseppe.be FPUSER=fastuser bash install-fastpanel.sh
#
# It writes the site's *includes* file (FastPanel never overwrites it), shows
# any file that wrongly contains a main-config block (events/http), tests
# Nginx and only reloads when the test passes; otherwise it restores the backup.
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-web.heyvaertseppe.be}"
FPUSER="${FPUSER:-fastuser}"
BACKEND="${BACKEND:-10.1.3.241:3080}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
INC="${INC:-$NGINX_DIR/fastpanel2-sites/$FPUSER/$DOMAIN.includes}"

ok()   { printf '\e[32m✔ %s\e[0m\n' "$*"; }
info() { printf '\e[36m➜ %s\e[0m\n' "$*"; }
warn() { printf '\e[33m! %s\e[0m\n' "$*"; }
die()  { printf '\e[31m✘ %s\e[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root."
command -v nginx >/dev/null || die "nginx not found."
[ -d "$(dirname "$INC")" ] || die "Folder $(dirname "$INC") not found. Set FPUSER=... (the FastPanel user that owns the site)."

# --- 1. find files that contain main-config blocks in the wrong place --------
info "Checking for main-config blocks (events/http) outside nginx.conf…"
BAD=$(grep -rlE '^[[:space:]]*(events|http)[[:space:]]*\{' "$NGINX_DIR" 2>/dev/null \
      | grep -v -x "$NGINX_DIR/nginx.conf" | grep -vE '\.(bak|orig|dpkg-[a-z]+)$|\.snaprevpro-backup' || true)
if [ -n "$BAD" ]; then
  warn "These files contain an 'events {' or 'http {' block. That only belongs in $NGINX_DIR/nginx.conf"
  warn "and causes: [emerg] \"events\" directive is not allowed here"
  echo "$BAD" | sed 's/^/     /'
fi

# --- 2. back up + write the includes file -----------------------------------
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUPS=()
backup() { if [ -f "$1" ]; then cp -p "$1" "$1.snaprevpro-backup-$STAMP"; BACKUPS+=("$1"); fi; }

backup "$INC"
# A wrong includes file is the usual culprit: it is replaced entirely.
# Other files with a main-config block are moved aside only if they are
# FastPanel include snippets (never nginx.conf or site configs).
for f in $BAD; do
  if [ "$f" = "$INC" ]; then continue; fi
  case "$f" in
    "$NGINX_DIR"/fastpanel2-includes/*|"$NGINX_DIR"/conf.d/*|"$NGINX_DIR"/snippets/*)
      backup "$f"; mv "$f" "$f.snaprevpro-disabled-$STAMP"; warn "Moved aside: $f  (copy kept as $f.snaprevpro-disabled-$STAMP)";;
    *) warn "Not touching $f: please remove its 'events'/'http' block by hand if 'nginx -t' still fails.";;
  esac
done

cat > "$INC" <<EOF
# snaprevpro: WebSocket + streaming + upload support (written by install-fastpanel.sh)
# Only 'location' and server-level directives here: this file is included
# inside the site's server { } block.

client_max_body_size 250m;

location /ws {
    proxy_pass http://$BACKEND;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}

location /stream {
    proxy_pass http://$BACKEND;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    gzip off;
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}

location ^~ /assets/ {
    proxy_pass http://$BACKEND;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
EOF
ok "Wrote $INC"

# --- 3. test, then reload or roll back ---------------------------------------
if nginx -t 2>/tmp/snaprevpro-nginx-test.txt; then
  ok "nginx -t passed"
  systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload
  ok "Nginx reloaded. Open https://$DOMAIN"
else
  cat /tmp/snaprevpro-nginx-test.txt >&2
  warn "nginx -t failed: restoring the previous files"
  rm -f "$INC"
  for f in "${BACKUPS[@]}"; do cp -p "$f.snaprevpro-backup-$STAMP" "$f"; done
  for f in $BAD; do [ -f "$f.snaprevpro-disabled-$STAMP" ] && mv "$f.snaprevpro-disabled-$STAMP" "$f"; done
  die "Nothing changed. The error above is in another file (see the list at the top), not in the snaprevpro snippet."
fi
