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
WebRTC all work as in a normal browser. Your device only shows a video-like
stream of the page and sends back your clicks, taps and keys.

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

## FastPanel setup (web.heyvaertseppe.be)

The backend address is **`http://127.0.0.1:3080`**: the container is on the same
server as FastPanel and only listens on localhost. If Nginx runs on a different
machine, change the port mapping to `"3080:8080"` and use that machine's LAN IP
(e.g. `http://192.168.1.50:3080`).

1. **DNS**: point an `A` record for `web.heyvaertseppe.be` to your public IP,
   and forward ports 80 and 443 on your router to the server (as for your other sites).
2. **Create the site** in FastPanel: *Sites → Create site*, domain
   `web.heyvaertseppe.be`. If your FastPanel offers a *Reverse proxy* /
   *Proxy* site type, choose it and enter `http://127.0.0.1:3080`. Otherwise
   create a normal site; step 4 replaces its config anyway.
3. **SSL**: on the site, open *SSL certificates → Let's Encrypt*, issue the
   certificate, and turn on *Redirect HTTP to HTTPS* (and HTTP/2).
4. **Nginx config**: open the site's *Configuration files* (the Nginx one) and
   replace the `location / { ... }` block with the three `location` blocks
   from [`nginx/web.heyvaertseppe.be.conf`](nginx/web.heyvaertseppe.be.conf)
   (between "copy from here" and "copy until here"). Also **remove** any
   static-file block such as `location ~* ^.+\.(jpg|jpeg|gif|png|css|js|…)$`;
   it would try to serve the app's files from disk. Add
   `client_max_body_size 250m;` to the server block if FastPanel has a smaller
   value. Save; FastPanel tests and reloads Nginx.
5. Visit `https://web.heyvaertseppe.be`. The first visit takes a few seconds while
   your browser starts. Log into Snapchat once, and you stay logged in.

What the Nginx config handles: SSL termination, the WebSocket upgrade on `/ws`
with a 1-day timeout, unbuffered uploads, and a `Permissions-Policy` header that
allows camera, microphone and clipboard on this site.

## How it works

| Requirement | How |
|---|---|
| Same URL for everyone | One domain and path. A signed `rb_uid` cookie (HttpOnly, 10 years) identifies the device. |
| Automatic provisioning | First visit: random ID, signed cookie, new profile dir `data/users/<id>/`. Nothing to configure. |
| Isolation | Each device gets its own Chromium process, its own profile directory, its own X display and its own audio devices. Screens and inputs are never shared. |
| Persistent login | The Chromium profile (cookies, IndexedDB, service workers, local storage) lives in `./data`. Browsers are shut down gracefully on idle or `docker stop`, so everything is flushed to disk. Tested: logins survive browser restarts and container restarts. |
| No passwords | The cookie *is* the login. Optional `ACCESS_CODE` (see below) asks new devices for a code once. |
| Camera | When the page calls `getUserMedia({video})`, your device's real webcam is captured (you get your browser's normal permission prompt), sent as JPEG frames, and fed into the remote page as a camera track. |
| Microphone | Your mic audio (24 kHz PCM) is written into a per-user PulseAudio microphone that Chromium uses natively. |
| Sound | Each browser plays into its own PulseAudio sink, which is streamed to you. Tap the 🔊 button to mute. |
| Clipboard | Ctrl/Cmd+V pastes your local text into the page. Copying in the page puts the text on your clipboard. |
| Files | Upload buttons in the page open your device's file picker. Downloads are delivered to your device. |
| Tabs/popups | Shown as tabs in the toolbar. |
| Phones | Tap = click, drag = scroll, long-press = right-click, ⌨ button = keyboard. Narrow screens get a scaled desktop layout. |
| Detection | Real Chromium, `navigator.webdriver` is false, no CDP `Runtime.enable`; the page sees a normal Chrome on Linux. |

### Toolbar

Back · Forward · Reload · Home · tabs · ⌨ (touch only) · 🔊 sound · **HD** (sharper
text on high-DPI screens, more bandwidth) · full screen · ⋯ menu:

* **Use this session on another device…** gives a private link that moves your
  login to another device. Anyone with this link can use your account, so don't share it.
* **Restart my browser**: use it if the page gets stuck. You stay logged in.
* **Hide toolbar**: a small arrow at the top right brings it back.

## Resources

Measured in the container on a simple test page:

* Gateway with nobody connected: **~20 MB**.
* Each **active** user: **~300 MB** extra (Chromium shares its code pages between users).
  Snapchat itself is heavier than the test page, so plan for **~400–600 MB per active user**.
* Users who closed the tab cost **0 MB**: their browser is stopped after
  `IDLE_TIMEOUT_MIN` (15 min) and restarted with the same profile on the next visit (~2–4 s).

About 100–200 MB per user isn't realistic for a full modern Chromium running
Snapchat. Every process-merging and feature-disabling option that doesn't break
the site is already on (see `chromeFlags` in `server/session.js`). The idle
shutdown is what keeps total RAM low. `MAX_SESSIONS` (default 8) caps how many run at once.
When full, the least-recently-used browser that nobody is looking at is stopped.

Bandwidth: screen updates are JPEG frames sent only when something changes,
typically 0.2–3 Mbit/s while active.

## Optional settings

All optional. Set them under `environment:` in `docker-compose.yml`.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_SESSIONS` | `8` | Max browsers running at the same time |
| `IDLE_TIMEOUT_MIN` | `15` | Stop a browser N minutes after its last tab closed |
| `ACCESS_CODE` | *(empty)* | If set, a new device must type this code once |
| `START_URL` | `https://web.snapchat.com/` | Page each browser opens |
| `JPEG_QUALITY` | `70` | Stream quality (10–95) |
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
server/session.js    one user's Xvfb + PulseAudio devices + Chromium, streaming, input
server/inject.js     script injected into pages: virtual camera, mic signalling, clipboard
server/cdp.js        tiny Chrome DevTools Protocol client over --remote-debugging-pipe
server/pulse.js      PulseAudio daemon + per-user sink/source
public/              the client page (canvas, toolbar, input, audio, camera)
nginx/               Nginx / FastPanel config
```
