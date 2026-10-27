# snaprevpro: a private, multi-user web app gateway

Open **https://web.heyvaertseppe.be** on any device and you get **your own private
Chromium**, running on the home server, already on **Snapchat Web**. Everyone uses
the same URL. Each device is recognised automatically and gets its own isolated,
persistent browser, so you log in once and stay logged in.

```
 phone / laptop ──HTTPS──▶ FastPanel Nginx ──▶ Docker container (127.0.0.1:3080)
   (any browser)            (SSL, WebSocket)     ├─ gateway (Node.js): cookies, routing, streaming
                                                 ├─ user A: Xvfb :100 + Chromium (profile /data/users/A)
                                                 ├─ user B: Xvfb :101 + Chromium (profile /data/users/B)
                                                 └─ PulseAudio (per-user speakers + microphone)
```

Snapchat runs in a real, unmodified Chromium, so it doesn't break the way
URL-rewriting proxies do. WebSockets, IndexedDB, WebCrypto, service workers and
WebRTC all work as in a normal browser.

The page fills your whole screen, with no toolbar or address bar. It is rendered
on the server at your screen's exact size and pixel density (e.g. 2× on a
retina laptop, ~2.6× on a phone) and sent as a **low-latency H.264 video
stream (up to 60 fps)**, which your browser decodes with its built-in
hardware decoder. Your clicks, taps and keys go back the same way. Everything,
video included, runs over the normal HTTPS connection on **port 443 only**.

## Quick start

```bash
git clone https://github.com/HeyvaertSeppe/snaprevpro.git
cd snaprevpro
docker compose up -d --build
```

Or without compose:

```bash
docker build -t snaprevpro .
docker run -d --name snaprevpro --restart unless-stopped \
  -p 127.0.0.1:3080:8080 -v "$PWD/data:/data" --shm-size=1g --stop-timeout 30 \
  snaprevpro
```

No secrets, env vars or setup steps are needed. On first start the container
generates its own cookie-signing key in `./data/secret.key`.

Check that it runs: `curl http://127.0.0.1:3080/healthz` → `{"ok":true,...}`

## Proxmox: one command

On the **Proxmox host** (as root), run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/HeyvaertSeppe/snaprevpro/claude/friendly-fermi-ri5uzx/proxmox/install-ct.sh)"
```

This creates a Debian 12 LXC container (10 cores, 20 GB RAM, 40 GB disk, Docker
inside, starts on boot), installs and starts snaprevpro, and prints the
address to use in FastPanel, e.g. `http://192.168.1.77:3080`. In the Nginx
config below, use that address instead of `127.0.0.1:3080`.

Options: `CTID=120 CORES=10 RAM_MB=20480 DISK_GB=40 BRIDGE=vmbr0 STORAGE=local-lvm
IP=192.168.1.77/24 GW=192.168.1.1 bash install-ct.sh` (all optional; a fixed IP
is recommended so the FastPanel address never changes).

## Reverse proxy / Cloudflare tunnel

Everything goes over **one HTTPS port (443)**: the page, the live connection
(WebSocket, with an automatic HTTP-stream fallback) and uploads. Devices are
identified by their cookie, never by IP address.

If a proxy blocks WebSockets, the page **still works**: it switches to an
HTTP stream by itself (and the container log says so). WebSockets are a bit
smoother, so it's worth enabling them as below.

### FastPanel (Nginx)

Keep the site config FastPanel generated (`location /` with
`proxy_pass http://<upstream>;` + `include /etc/nginx/proxy_params;`). Add the
WebSocket support in the site's **includes file**, which FastPanel never
overwrites:

**Easiest:** run this on the FastPanel server as root. It writes the
includes file, tests Nginx, and only reloads if the test passes (otherwise it
restores the previous files):

```bash
curl -fsSL https://raw.githubusercontent.com/HeyvaertSeppe/snaprevpro/claude/friendly-fermi-ri5uzx/nginx/install-fastpanel.sh -o install-fastpanel.sh
BACKEND=10.1.3.241:3080 bash install-fastpanel.sh
```

**By hand:**

1. Copy [`nginx/fastpanel-includes.conf`](nginx/fastpanel-includes.conf) into
   `/etc/nginx/fastpanel2-sites/fastuser/web.heyvaertseppe.be.includes`
   (change `10.1.3.241:3080` if your container has another address). Paste
   **only** that file: it goes inside the site's `server { }` block. A full
   `nginx.conf` (with `user`/`events`/`http`) there gives
   `[emerg] "events" directive is not allowed here`.
2. `nginx -t && systemctl reload nginx`

It adds `location /ws` (HTTP/1.1 + `Upgrade` headers, no timeout),
`location /stream` (unbuffered), `location ^~ /assets/` (so the app files never
come from FastPanel's static-file rule) and `client_max_body_size 250m`.
FastPanel's plain `proxy_params` has none of these, which is what causes an
endless "Reconnecting…" with older versions of this app.

### Cloudflare tunnel

In Cloudflare Zero Trust → *Networks → Tunnels → your tunnel → Public
hostname*, add `web.heyvaertseppe.be` with **one** of these services:

* **Recommended, directly to the container** (skips FastPanel/Nginx entirely,
  nothing to configure there, fewest hops): Type `HTTP`, URL `10.1.3.241:3080`.
* **Through FastPanel's Nginx**: type `HTTP`, URL `10.1.2.222:80`, and under
  *Additional application settings → HTTP Settings* set **HTTP Host Header**
  to `web.heyvaertseppe.be`. (With type `HTTPS` → `10.1.2.222:443`, also set
  *Origin Server Name* `web.heyvaertseppe.be` or enable *No TLS Verify*.)

In the Cloudflare dashboard for the domain:

* *Network* → **WebSockets: On** (default)
* *Speed → Optimization* → **Rocket Loader: Off** (it rewrites the page's script)
* *SSL/TLS* → *Edge Certificates* → **Always Use HTTPS: On** (camera and mic need HTTPS)

No cache rules are needed: the page is sent as `no-store`, and app files carry
a version (`app.js?v=…`), so an update never mixes old and new code.

### Without Cloudflare (port forwarding)

Point an `A` record at your public IP, forward 80/443 to the FastPanel server,
issue a Let's Encrypt certificate for the site in FastPanel, and add the
includes file as above. A complete stand-alone Nginx server block is in
[`nginx/web.heyvaertseppe.be.conf`](nginx/web.heyvaertseppe.be.conf).

### Still "Reconnecting…"?

Run `docker compose logs --tail 50` in `/opt/snaprevpro`. The gateway logs one
clear line for each proxy problem it sees: WebSocket headers missing, Host
header rewritten, or Cookie header stripped.

## How it works

| Requirement | How |
|---|---|
| Same URL for everyone | One domain and path. A signed `rb_uid` cookie (HttpOnly, 10 years) identifies the device, **never the IP address**, so any number of people behind the same home IP each get their own session. |
| Automatic provisioning | First visit: random ID, signed cookie, new profile dir `data/users/<id>/`. Nothing to configure. |
| Isolation | Each device gets its own Chromium process, its own profile directory, its own X display and its own audio devices. Screens and inputs are never shared. |
| Persistent login | The Chromium profile (cookies, IndexedDB, service workers, local storage) lives in `./data`. Browsers are shut down gracefully on idle or `docker stop`, so everything is flushed to disk. Tested: logins survive browser restarts and container restarts. |
| No passwords | The cookie *is* the login. Optional `ACCESS_CODE` (see below) asks new devices for a code once. |
| Camera | When the page calls `getUserMedia({video})`, your device's real webcam is captured (you get your browser's normal permission prompt), sent as JPEG frames, and fed into the remote page as a camera track. |
| Microphone | Your mic audio (24 kHz PCM) is written into a per-user PulseAudio microphone that Chromium uses natively. |
| Sound | Each browser plays into its own PulseAudio sink, which is streamed to you. Tap the 🔊 button to mute. |
| Clipboard | Ctrl/Cmd+V pastes your local text into the page. Copying in the page puts the text on your clipboard. |
| Files | Upload buttons in the page open your device's file picker. Downloads are delivered to your device. |
| Picture | Chromium renders the page at your exact CSS size and device pixel ratio. The region is captured from the virtual screen and encoded with x264 (`zerolatency`, no B-frames) at up to 60 fps; your browser decodes it with WebCodecs. If your device can't keep up, the frame rate drops automatically. Browsers without WebCodecs fall back to a JPEG stream. |
| Cursor | Drawn by your own device (no lag); its shape follows the page (pointer, text, …). |
| Links | A link to another website that opens a new window opens **on your own device** instead. A Snapchat popup shows a small ✕ to close it; your phone's/browser's back button also closes it (or goes back inside the page). |
| Phones | Native size and sharpness. Tap = click, swipe = scroll (with momentum), long-press = right-click. Tapping a text field opens your keyboard (on iPhone you may need to tap the field a second time). |
| Detection | Real Chromium, `navigator.webdriver` is false, no CDP `Runtime.enable`; the page sees a normal Chrome on Linux. |

Tip: on a phone, use "Add to Home screen" and open it from there. It then
runs full screen like an app.

### Hidden menu

There's no visible UI. A hidden menu opens with **Ctrl+Alt+Shift+M**, a
**three-finger tap**, or by opening `https://web.heyvaertseppe.be/#menu`:

* **Use this session on another device…** gives a private link that moves your
  login to another device. Anyone with this link can use your account, so don't share it.
* **Restart my browser**: use it if the page gets stuck. You stay logged in.
* **Sound on/off**
* **Instant typing preview on/off** (see *Speed* below)
* **Connection info**: round-trip time, frames per second, decode time,
  picture size and connection type, live in a corner of the screen

## Resources

Measured in the container on a simple test page:

* Gateway with nobody connected: **~20 MB**.
* Each **active** user: **~450 MB** on a 2× (retina) screen. Rendering at full
  sharpness costs more than a low-resolution picture would. Snapchat is heavier
  than the test page, so plan for **~600–800 MB per active user**.
* CPU: rendering plus video encoding uses roughly **1–2.5 cores per user while
  something moves** and close to zero on a still screen. Set `FPS=30` to halve
  the encoding work.
* Users who closed the tab cost **0 MB**: their browser is stopped after
  `IDLE_TIMEOUT_MIN` (15 min) and restarted with the same profile on the next visit (~2–4 s).

About 100–200 MB per user isn't realistic for a full modern Chromium running
Snapchat. Every process-merging and feature-disabling option that doesn't break
the site is already on (see `chromeFlags` in `server/session.js`). The idle
shutdown is what keeps total RAM low. `MAX_SESSIONS` (default 8) caps how many run at once.
When full, the least-recently-used browser that nobody is looking at is stopped.

Bandwidth: under 0.5 Mbit/s on a still page, typically 2–8 Mbit/s while
scrolling or watching video (capped by `VIDEO_MAX_MBIT`).

**Latency**: what you feel is your network round-trip plus about 30–60 ms
(capture, encode, decode). On the same Wi-Fi as the server that's near-instant.
Over 4G it feels like a fast remote desktop. It can never be exactly as instant
as running Snapchat on the device itself.

## Speed: why typing can feel delayed, and what helps

Every key press travels device → Cloudflare → your home → the browser in the
container, and the updated picture travels back. What you feel is roughly:
**network round trip + ~1–3 frames** (render, capture/encode, decode).
FastPanel/Nginx adds well under 1 ms; the round trip is what counts.

What the app does about it:

* **Instant typing preview** (on by default): letters you type appear at
  once at the text cursor, in the field's own font and colour, and are
  replaced by the real text when the video catches up (the same trick Mosh
  and cloud-gaming apps use). Measured: the preview appears within 0–3 ms of
  the key press.
* Video at up to 60 fps with a low-latency encoder. The frame rate is only
  lowered when a device's decoder really can't keep up.
* The page's position on the virtual screen is measured to the pixel, so
  clicks and the typing preview land exactly where you expect.

What you can do:

* Open the hidden menu → **Connection info**. If *round trip* is high
  (> 80 ms), the delay is the network/tunnel, not the server.
* Point the Cloudflare tunnel **directly at the container** (above).
* At home on the same network, open `http://10.1.3.241:3080` directly: the
  round trip drops to a few ms. (Camera/mic need HTTPS, so use the normal
  address for video calls.)
* If *decode* is high on an old phone, set `FPS=30` in `docker-compose.yml`.

Why not just proxy the real Snapchat site into your own browser? That's the
URL-rewriting approach that breaks Snapchat ("Browser niet ondersteund" /
"Er is iets misgegaan"): Snapchat ties its login, cookies and security checks
to `web.snapchat.com`. It wouldn't be faster than opening web.snapchat.com on
the device either. On a device that can run Snapchat Web itself, opening
web.snapchat.com directly is the only way to get truly native speed. This
gateway is for shared, always-logged-in sessions and devices that can't.

## Optional settings

All optional. Set them under `environment:` in `docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_SESSIONS` | `8` | Max browsers running at the same time |
| `IDLE_TIMEOUT_MIN` | `15` | Stop a browser N minutes after its last tab closed |
| `ACCESS_CODE` | *(empty)* | If set, a new device must type this code once |
| `START_URL` | `https://web.snapchat.com/` | Page each browser opens |
| `FPS` | `60` | Video frames per second (lower = less CPU/bandwidth) |
| `VIDEO_CRF` | `20` | Video quality: lower = sharper, more bandwidth (18–28 sensible) |
| `VIDEO_MAX_MBIT` | `12` | Bandwidth cap per viewer |
| `X264_PRESET` | `superfast` | Encoder speed/quality (`ultrafast` = least CPU) |
| `JPEG_QUALITY` | `80` | Quality of the fallback stream for old browsers |
| `MAX_UPLOAD_MB` | `250` | Upload size limit |

## Security notes

* Anyone who can reach the URL gets a browser on your server, running from your
  home IP. If the domain is public, consider setting `ACCESS_CODE`.
* Profiles in `./data/users/` contain everyone's logged-in sessions. Keep the
  folder private and back it up.
* Chromium runs with `--no-sandbox` (its sandbox needs extra container
  privileges). Users are separated by process, profile and display, and the
  container runs as an unprivileged user.
* The cookie is HMAC-signed with `data/secret.key`. Deleting that file logs
  every device out (profiles stay on disk but become unreachable).

## Maintenance

```bash
docker compose logs -f                        # logs
git pull && docker compose up -d --build      # update (also updates Chromium)
docker compose down                           # stop (profiles are saved first)
```

Rebuild every few weeks so Chromium stays current; Snapchat may reject old browsers.

## Project layout

```
server/index.js      HTTP + WebSocket gateway, device cookies, uploads/downloads
server/session.js    one user's Xvfb + PulseAudio devices + Chromium, page placement, input
server/video.js      ffmpeg x11grab → H.264 encoder, split into frames for WebCodecs
server/httpstream.js HTTP streaming fallback when a proxy blocks WebSockets
server/inject.js     script injected into pages: virtual camera, mic signalling, clipboard
server/cdp.js        tiny Chrome DevTools Protocol client over --remote-debugging-pipe
server/pulse.js      PulseAudio daemon + per-user sink/source
public/              the client page (full-screen video, input, audio, camera; no UI)
nginx/               Nginx / FastPanel config
```
