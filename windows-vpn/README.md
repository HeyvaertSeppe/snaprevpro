# SnapVPN (Windows)

A small, portable AnyConnect-compatible VPN client for Windows. It's one
`.exe` with nothing to install. It always connects to
`bsd46.heyvaertseppe.qzz.io` as `bypass`, so the only thing it asks for is
the password.

## Getting the .exe

Every push that touches `windows-vpn/` runs the **Build Windows VPN app**
workflow. Open the run in the GitHub Actions tab and download the
`SnapVPN` artifact (a zip holding `SnapVPN.exe`). You can also start
the workflow by hand with "Run workflow".

## Using it

- Windows asks for admin rights at launch (UAC). OpenConnect needs them to
  create the network adapter and set routes and DNS.
- On first launch, enter the password. With **Remember password** ticked, it
  is saved encrypted with Windows DPAPI, so only your Windows account on this
  PC can decrypt it. Later launches connect straight away.
- If the connection drops, it reconnects by itself (2s, 3s, 5s … up to 30s
  between tries). A wrong password stops retrying and asks for it again.
- Closing the window hides it to the tray. Right-click the tray icon to
  connect, disconnect or **Quit**. Double-click it to open the window.
- **Start with Windows** registers a Task Scheduler logon task with highest
  privileges. A registry Run key can't be used here: Windows silently skips
  Run-key programs that need admin rights. The task starts the app in the tray
  at sign-in, with no UAC prompt, and it auto-connects.
- Launching the .exe again just brings the running window to the front.
- SnapVPN sets up the VPN adapter itself (address, DNS, routes). OpenConnect
  normally does this with a Windows Script Host script, but that is broken or
  disabled on some PCs, so the bundled OpenConnect is patched to run
  `snapvpn-hook.exe` instead (see `scripts/snapvpn-hook.c`). Every network
  change shows in "Show log" as a `net:` line.
- With a full tunnel, IPv6 is routed into the VPN too, like AnyConnect does,
  so it can't leak around the VPN over Wi-Fi. A few seconds after connecting,
  `windows:` lines in the log show how Windows sees each connection.
- When a browser tab with Snapchat Web comes to the front while you're
  connected, a small "Connected using SnapVPN" card shows over the browser for
  a few seconds (once a minute at most). It doesn't take focus, and a click
  closes it. When you're not connected, nothing is shown.

Files are kept in `%APPDATA%\SnapVPN\`: `settings.json` (with the encrypted
password blob) and `vpn.log`. **Forget password** clears the saved password.

## What's inside

| Part | Source |
| --- | --- |
| `openconnect.exe` + DLLs | Built from OpenConnect `v9.12` (GnuTLS) with MSYS2 UCRT64 in CI |
| `wintun.dll` | Official signed Wintun 0.14.1 build (SHA-256 checked) |
| `snapvpn-hook.exe` | `scripts/snapvpn-hook.c`, built in CI |
| UI | Python + customtkinter, pystray for the tray |

## Building locally (on Windows)

1. Install MSYS2, open the **UCRT64** shell, install the packages listed in
   `.github/workflows/windows-vpn.yml`, then run `bash scripts/build_openconnect.sh`.
2. In a normal terminal, from `windows-vpn/`:

   ```
   pip install -r requirements.txt
   python scripts/make_icon.py
   pyinstaller --noconfirm SnapVPN.spec
   ```

The result is `dist\SnapVPN.exe`.
