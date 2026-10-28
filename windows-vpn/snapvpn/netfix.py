"""Logs how Windows sees each network after the VPN comes up.

Windows shows the Ethernet icon in the taskbar when it treats the VPN
adapter as the main internet connection ("IPv4 Internet" below). These
lines make it easy to see why if it doesn't.
"""

import subprocess

_NO_WINDOW = 0x08000000

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


def network_report() -> list[str]:
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", _DIAG],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=40, creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return [f"windows: could not read network state: {e}"]
    out = (res.stdout + res.stderr).decode("utf-8", "replace")
    return [ln.rstrip() for ln in out.splitlines() if ln.strip()]
