#!/bin/sh
# Fix ownership of the data volume (bind mounts are often created by root),
# then drop privileges and start the gateway.
set -e
mkdir -p /data
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /data 2>/dev/null || true
  rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true
  exec setpriv --reuid=app --regid=app --init-groups node /app/server/index.js
fi
exec node /app/server/index.js
