# Multi-user remote browser gateway: one container, one Chromium per device.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      pulseaudio pulseaudio-utils \
      ffmpeg \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji fonts-noto-core \
      ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/* \
 # never auto-spawn a second PulseAudio; the gateway starts exactly one
 && mkdir -p /etc/pulse/client.conf.d \
 && echo "autospawn = no" > /etc/pulse/client.conf.d/00-gateway.conf \
 # unprivileged user that runs everything
 && userdel -r node 2>/dev/null || true \
 && useradd --create-home --uid 1000 --shell /usr/sbin/nologin app \
 && mkdir -p /data /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix \
 && chown app:app /data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
# Chromium policy: no info bars (they would shift the page) and no prompts
COPY docker/chromium-policy.json /etc/chromium/policies/managed/gateway.json
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HOME=/home/app

EXPOSE 8080
VOLUME ["/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
