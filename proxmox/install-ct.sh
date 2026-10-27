#!/usr/bin/env bash
# =============================================================================
# snaprevpro: one-shot Proxmox installer
#
# Run this ON THE PROXMOX HOST as root. It will:
#   1. create a Debian 12 LXC container (10 cores, 20 GB RAM, 40 GB disk)
#   2. install Docker inside it
#   3. download snaprevpro and start it
#   4. print the address to enter in FastPanel
#
# Usage:   bash install-ct.sh
# Options (all optional, as environment variables):
#   CTID=120 CORES=10 RAM_MB=20480 DISK_GB=40 BRIDGE=vmbr0 STORAGE=local-lvm \
#   IP=dhcp  (or e.g. IP=192.168.1.50/24 GW=192.168.1.1)  bash install-ct.sh
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/HeyvaertSeppe/snaprevpro.git}"
REPO_BRANCH="${REPO_BRANCH:-claude/friendly-fermi-ri5uzx}"
CT_HOSTNAME="${CT_HOSTNAME:-snaprevpro}"
CORES="${CORES:-10}"
RAM_MB="${RAM_MB:-20480}"
SWAP_MB="${SWAP_MB:-2048}"
DISK_GB="${DISK_GB:-40}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GW="${GW:-}"
PORT=3080

c_ok()   { printf '\e[32m✔ %s\e[0m\n' "$*"; }
c_info() { printf '\e[36m➜ %s\e[0m\n' "$*"; }
die()    { printf '\e[31m✘ %s\e[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks
[ "$(id -u)" = 0 ] || die "Run as root on the Proxmox host."
command -v pct >/dev/null && command -v pveam >/dev/null || die "This is not a Proxmox host (pct/pveam not found)."
ip link show "$BRIDGE" >/dev/null 2>&1 || die "Network bridge '$BRIDGE' not found. Set BRIDGE=... (see: ip -br link)."

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
pct status "$CTID" >/dev/null 2>&1 && die "Container ID $CTID already exists. Set CTID=... to another free ID."

# storage for the container disk: prefer local-lvm, else the first storage that holds containers
if [ -z "${STORAGE:-}" ]; then
  if pvesm status --content rootdir 2>/dev/null | awk 'NR>1{print $1}' | grep -qx local-lvm; then
    STORAGE=local-lvm
  else
    STORAGE="$(pvesm status --content rootdir | awk 'NR>1 && $3=="active"{print $1; exit}')"
  fi
fi
[ -n "$STORAGE" ] || die "No storage for containers found. Set STORAGE=..."

# storage for templates: prefer 'local'
TSTORAGE="$(pvesm status --content vztmpl | awk 'NR>1 && $3=="active"{print $1}' | grep -x local || true)"
[ -n "$TSTORAGE" ] || TSTORAGE="$(pvesm status --content vztmpl | awk 'NR>1 && $3=="active"{print $1; exit}')"
[ -n "$TSTORAGE" ] || die "No storage for templates found (enable 'Container template' content on a storage)."

# ---------------------------------------------------------------- template
c_info "Looking for the Debian 12 container template…"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard_.*amd64\.tar\.(zst|gz|xz)$' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "Debian 12 template not found in 'pveam available'."
if ! pveam list "$TSTORAGE" | grep -q "$TEMPLATE"; then
  c_info "Downloading $TEMPLATE…"
  pveam download "$TSTORAGE" "$TEMPLATE" >/dev/null
fi
c_ok "Template: $TEMPLATE"

# ---------------------------------------------------------------- create CT
NET="name=eth0,bridge=$BRIDGE,ip=$IP"
[ -n "$GW" ] && NET="$NET,gw=$GW"

c_info "Creating container $CTID ($CORES cores, $((RAM_MB/1024)) GB RAM, ${DISK_GB} GB disk on $STORAGE)…"
pct create "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --swap "$SWAP_MB" \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "$NET" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --ostype debian \
  --description "snaprevpro: multi-user Snapchat Web gateway (Docker). Port $PORT." >/dev/null
pct start "$CTID"
c_ok "Container $CTID started"

# ---------------------------------------------------------------- wait for network
c_info "Waiting for the container to get an IP address…"
CT_IP=""
for _ in $(seq 1 60); do
  CT_IP="$(pct exec "$CTID" -- sh -c "ip -4 -o addr show dev eth0 | awk '{print \$4}' | cut -d/ -f1 | head -1" 2>/dev/null || true)"
  if [ -n "$CT_IP" ] && pct exec "$CTID" -- sh -c "getent hosts deb.debian.org >/dev/null" 2>/dev/null; then break; fi
  sleep 2
done
[ -n "$CT_IP" ] || die "Container got no IP address. Check DHCP / BRIDGE / IP settings."
c_ok "Container IP: $CT_IP"

# ---------------------------------------------------------------- install inside CT
c_info "Installing Docker and snaprevpro inside the container (takes a few minutes)…"
pct exec "$CTID" -- env REPO_URL="$REPO_URL" REPO_BRANCH="$REPO_BRANCH" bash -s <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git >/dev/null

# Docker (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
systemctl enable --now docker >/dev/null 2>&1

# Project
if [ -d /opt/snaprevpro/.git ]; then
  git -C /opt/snaprevpro pull -q
else
  git clone -q -b "$REPO_BRANCH" "$REPO_URL" /opt/snaprevpro
fi
cd /opt/snaprevpro
# FastPanel runs on another machine, so listen on the container's network.
echo "BIND_ADDR=0.0.0.0" > .env
docker compose up -d --build

# Wait until it answers
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3080/healthz >/dev/null 2>&1 && exit 0
  sleep 2
done
echo "snaprevpro did not become healthy; see: docker compose -f /opt/snaprevpro/docker-compose.yml logs" >&2
exit 1
INNER
c_ok "snaprevpro is running"

# ---------------------------------------------------------------- done
cat <<EOF

=====================================================================
  DONE.  Enter this as the proxy backend in FastPanel:

        http://$CT_IP:$PORT

  (container $CTID "$CT_HOSTNAME", starts automatically on boot)
=====================================================================

In FastPanel's Nginx config for web.heyvaertseppe.be, replace every
127.0.0.1:3080 from nginx/web.heyvaertseppe.be.conf with $CT_IP:$PORT.

Tip: give the container a fixed IP (DHCP reservation in your router, or
re-run with IP=$CT_IP/24 GW=<router-ip>) so this address never changes.

Useful commands on the Proxmox host:
  pct enter $CTID                                   # shell in the container
  pct exec $CTID -- docker compose -f /opt/snaprevpro/docker-compose.yml logs -f
  pct exec $CTID -- sh -c 'cd /opt/snaprevpro && git pull && docker compose up -d --build'   # update
EOF
