"""Post-connect network tweaks and diagnostics.

Windows shows the Ethernet icon in the taskbar when it treats the VPN
adapter as the main internet connection. With a full tunnel the routing
script only sends IPv4 through the VPN. If Wi-Fi also has IPv6 internet
(common with Belgian ISPs), Windows keeps treating Wi-Fi as the main
connection, and IPv6 traffic quietly bypasses the VPN. Cisco AnyConnect
avoids both by also routing IPv6 into the tunnel in full-tunnel mode, and
that is what this does.
"""

import os
import subprocess
import tempfile
from typing import Callable

_NO_WINDOW = 0x08000000

# vpnc-script-win.js appends its own log here when LOG2FILE is set.
SCRIPT_LOG = os.path.join(tempfile.gettempdir(), "vpnc.log")

_FIX = r"""
$ErrorActionPreference = 'SilentlyContinue'
$a = Get-NetAdapter -Name '{adapter}'
if (-not $a) {{ "network: adapter '{adapter}' not found"; exit 0 }}
$idx = $a.ifIndex
if (Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -InterfaceIndex $idx) {{
  "network: full tunnel - all traffic goes through the VPN"
  Get-NetIPInterface -InterfaceIndex $idx | Set-NetIPInterface -InterfaceMetric 1
  if (-not (Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -InterfaceIndex $idx)) {{
    $r = New-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -InterfaceIndex $idx `
         -NextHop '::' -RouteMetric 0 -PolicyStore ActiveStore
    if ($r) {{ "network: IPv6 now routed into the VPN too (like AnyConnect)" }}
    else {{ "network: could not route IPv6 into the VPN: $($Error[0])" }}
  }}
}} else {{
  "network: split tunnel - the server only sends some networks through the VPN,"
  "network: so Windows keeps using Wi-Fi/Ethernet as the main connection"
}}
"""

_DIAG = r"""
$ErrorActionPreference = 'SilentlyContinue'
Get-NetConnectionProfile | ForEach-Object {
  "windows: {0} -> IPv4 {1}, IPv6 {2}" -f $_.InterfaceAlias, $_.IPv4Connectivity, $_.IPv6Connectivity
}
Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -PolicyStore ActiveStore | ForEach-Object {
  $if = Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily $_.AddressFamily
  "windows: default route {0} on {1} (metric {2})" -f $_.DestinationPrefix, $_.InterfaceAlias, ($_.RouteMetric + $if.InterfaceMetric)
}
"""


def _powershell(script: str, timeout: int = 40) -> list[str]:
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", script],
            capture_output=True, text=True, timeout=timeout, creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return [f"network: PowerShell failed: {e}"]
    return [ln.rstrip() for ln in (res.stdout + res.stderr).splitlines() if ln.strip()]


def script_log_size() -> int:
    try:
        return os.path.getsize(SCRIPT_LOG)
    except OSError:
        return 0


def read_script_log(offset: int) -> list[str]:
    """Lines the routing script wrote since `offset`."""
    try:
        with open(SCRIPT_LOG, "rb") as f:
            f.seek(offset)
            data = f.read()
    except OSError:
        return []
    return ["script: " + ln.rstrip() for ln in data.decode("utf-8", "replace").splitlines() if ln.strip()]


def after_connect(adapter: str, log: Callable[[str], None], wait: Callable[[float], bool]) -> None:
    """Apply the full-tunnel IPv6 route, then log how Windows sees the networks.

    `wait(seconds)` returns True if we should stop early (disconnected).
    """
    for line in _powershell(_FIX.format(adapter=adapter.replace("'", "''"))):
        log(line)
    # Give Windows' connectivity check a moment to re-evaluate.
    if wait(10):
        return
    for line in _powershell(_DIAG):
        log(line)
