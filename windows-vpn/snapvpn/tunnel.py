"""Configures the VPN adapter from the settings openconnect hands over.

This replaces vpnc-script-win.js. openconnect runs snapvpn-hook.exe, which
drops its environment into a file (see scripts/snapvpn-hook.c). This module
picks those files up and applies them with netsh/route, logging every step.

Full tunnel (server sends no split routes): every IPv4 route goes through
the VPN, and IPv6 is routed into the tunnel too, like Cisco AnyConnect does,
so it can't leak around the VPN over Wi-Fi.
"""

import ctypes
import glob
import os
import shutil
import socket
import struct
import subprocess
import threading
from ctypes import wintypes
from typing import Callable

from .config import DATA_DIR

HOOK_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or DATA_DIR, "SnapVPN", "hook")
_NO_WINDOW = 0x08000000

Log = Callable[[str], None]


# --- helpers -----------------------------------------------------------------

def _run(cmd: list[str], log: Log) -> bool:
    try:
        res = subprocess.run(
            cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=15,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"net: {' '.join(cmd)} -> {e}")
        return False
    out = (res.stdout + res.stderr).decode("utf-8", "replace").strip()
    # netsh prints "Ok." on success (localised), route prints "OK!".
    if res.returncode != 0:
        log(f"net: {' '.join(cmd)} -> failed ({res.returncode}) {out}")
        return False
    log(f"net: {' '.join(cmd)}")
    return True


def _netsh(*args: str, log: Log) -> bool:
    return _run(["netsh.exe", *args], log)


def _route(*args: str, log: Log) -> bool:
    return _run(["route.exe", *args], log)


class _ForwardRow(ctypes.Structure):
    _fields_ = [(n, wintypes.DWORD) for n in (
        "dest", "mask", "policy", "nexthop", "ifindex", "type", "proto", "age",
        "nexthop_as", "metric1", "metric2", "metric3", "metric4", "metric5")]


def _best_route(ip: str) -> tuple[str, int] | None:
    """(next hop, interface index) Windows currently uses to reach `ip`."""
    try:
        dest = struct.unpack("<I", socket.inet_aton(ip))[0]
    except OSError:
        return None
    row = _ForwardRow()
    fn = ctypes.WinDLL("iphlpapi").GetBestRoute
    fn.argtypes = [wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_ForwardRow)]
    fn.restype = wintypes.DWORD
    if fn(dest, 0, ctypes.byref(row)) != 0:
        return None
    return socket.inet_ntoa(struct.pack("<I", row.nexthop)), row.ifindex


def _mask_to_len(mask: str) -> int:
    try:
        return bin(struct.unpack("!I", socket.inet_aton(mask))[0]).count("1")
    except OSError:
        return 32


# --- tunnel configuration ----------------------------------------------------

class Tunnel:
    """Applies one session's settings and undoes the bits that outlive it."""

    def __init__(self, log: Log):
        self.log = log
        self._cleanup: list[list[str]] = []  # route.exe deletes for disconnect
        self.full_tunnel = False

    def connect(self, env: dict[str, str]) -> bool:
        log = self.log
        idx = env.get("TUNIDX", "")
        ip4 = env.get("INTERNAL_IP4_ADDRESS", "")
        if not idx or not ip4:
            log(f"net: missing tunnel settings (TUNIDX={idx!r}, address={ip4!r})")
            return False
        mask = env.get("INTERNAL_IP4_NETMASK") or "255.255.255.255"
        vpngw = env.get("VPNGATEWAY", "")
        split = int(env.get("CISCO_SPLIT_INC") or 0)
        includes = [(env.get(f"CISCO_SPLIT_INC_{i}_ADDR", ""), env.get(f"CISCO_SPLIT_INC_{i}_MASKLEN", ""))
                    for i in range(split)]
        includes = [(a, m) for a, m in includes if a and m]
        if any(a == "0.0.0.0" and m == "0" for a, m in includes):
            includes = []  # a 0.0.0.0/0 "split" route is just a full tunnel
        self.full_tunnel = not includes
        ok = True

        log(f"net: tunnel adapter index {idx}, address {ip4}/{_mask_to_len(mask)}, "
            + ("full tunnel" if self.full_tunnel else f"split tunnel ({len(includes)} routes)"))

        # 1. Keep reaching the VPN server itself over the normal connection.
        #    Must be looked up before we add the tunnel's default route.
        best = _best_route(vpngw) if vpngw and ":" not in vpngw else None
        if best and best[0] != "0.0.0.0":
            nexthop, ifidx = best
            if _route("add", vpngw, "mask", "255.255.255.255", nexthop, "if", str(ifidx), log=log):
                self._cleanup.append(["delete", vpngw, "mask", "255.255.255.255", nexthop])

        # 2. Address, MTU.
        if env.get("INTERNAL_IP4_MTU"):
            _netsh("interface", "ipv4", "set", "subinterface", idx,
                   f"mtu={env['INTERNAL_IP4_MTU']}", "store=active", log=log)
        ok &= _netsh("interface", "ipv4", "set", "address", f"name={idx}", "source=static",
                     f"address={ip4}", f"mask={mask}", "store=active", log=log)

        # 3. DNS servers from the VPN.
        _netsh("interface", "ipv4", "delete", "dnsservers", idx, "all", log=log)
        _netsh("interface", "ipv6", "delete", "dnsservers", idx, "all", log=log)
        for dns in (env.get("INTERNAL_IP4_DNS") or "").split():
            fam = "ipv6" if ":" in dns else "ipv4"
            _netsh("interface", fam, "add", "dnsservers", idx, dns, "validate=no", log=log)

        # 4. Routes.
        if self.full_tunnel:
            _netsh("interface", "ipv4", "set", "interface", idx, "metric=1", "store=active", log=log)
            ok &= _netsh("interface", "ipv4", "add", "route", "0.0.0.0/0", idx, "0.0.0.0",
                         "metric=0", "store=active", log=log)
        else:
            for addr, length in includes:
                _netsh("interface", "ipv4", "add", "route", f"{addr}/{length}", idx, "0.0.0.0",
                       "store=active", log=log)
        if best and best[0] != "0.0.0.0":
            for i in range(int(env.get("CISCO_SPLIT_EXC") or 0)):
                addr = env.get(f"CISCO_SPLIT_EXC_{i}_ADDR", "")
                emask = env.get(f"CISCO_SPLIT_EXC_{i}_MASK", "")
                if addr and emask and _route("add", addr, "mask", emask, best[0], "if", str(best[1]), log=log):
                    self._cleanup.append(["delete", addr, "mask", emask, best[0]])

        # 5. IPv6.
        ip6 = env.get("INTERNAL_IP6_ADDRESS", "")
        net6 = env.get("INTERNAL_IP6_NETMASK", "")
        if ip6 or (net6 and "/" in net6):
            addr6 = ip6 or net6.split("/")[0]
            _netsh("interface", "ipv6", "set", "address", idx, addr6, "store=active", log=log)
            if net6 and not net6.endswith("/128"):
                _netsh("interface", "ipv6", "add", "route", net6, idx, "store=active", log=log)
        inc6 = int(env.get("CISCO_IPV6_SPLIT_INC") or 0)
        if inc6:
            for i in range(inc6):
                addr = env.get(f"CISCO_IPV6_SPLIT_INC_{i}_ADDR", "")
                length = env.get(f"CISCO_IPV6_SPLIT_INC_{i}_MASKLEN", "")
                if addr and length:
                    _netsh("interface", "ipv6", "add", "route", f"{addr}/{length}", idx, "store=active", log=log)
        elif self.full_tunnel and ":" not in vpngw:
            # All IPv6 into the tunnel. Without an IPv6 address from the
            # server it is dropped there instead of leaking over Wi-Fi.
            _netsh("interface", "ipv6", "set", "interface", idx, "metric=1", "store=active", log=log)
            _netsh("interface", "ipv6", "add", "route", "::/0", idx, "metric=0", "store=active", log=log)

        log("net: tunnel configured" if ok else "net: tunnel configured with errors (see above)")
        return ok

    def disconnect(self) -> None:
        # Everything on the adapter disappears with it; only the routes we
        # put on the normal connection need removing.
        for args in self._cleanup:
            _route(*args, log=self.log)
        self._cleanup.clear()


# --- hook file handling ------------------------------------------------------

def _read_env(path: str) -> dict[str, str]:
    with open(path, "rb") as f:
        data = f.read()
    env = {}
    for item in data.decode("utf-8", "replace").split("\0"):
        if "=" in item:
            k, v = item.split("=", 1)
            env[k.upper()] = v
    return env


class HookWatcher:
    """Handles snapvpn-hook.exe events for one openconnect session."""

    def __init__(self, log: Log, on_configured: Callable[[bool, bool], None]):
        self.log = log
        self.on_configured = on_configured  # (ok, full_tunnel)
        self.tunnel = Tunnel(log)
        self._stop = threading.Event()
        shutil.rmtree(HOOK_DIR, ignore_errors=True)
        os.makedirs(HOOK_DIR, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, name="hook-watcher", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(0.1):
            for path in sorted(glob.glob(os.path.join(HOOK_DIR, "*.env"))):
                self._handle(path)

    def _handle(self, path: str) -> None:
        base = path[:-4]
        reason = os.path.basename(base).split("-", 1)[-1]
        try:
            env = _read_env(path)
        except OSError:
            return
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        try:
            if reason == "connect":
                ok = self.tunnel.connect(env)
                self.on_configured(ok, self.tunnel.full_tunnel)
            elif reason == "disconnect":
                self.tunnel.disconnect()
            # pre-init, reconnect, attempt-reconnect: nothing to change
        except Exception as e:  # never leave openconnect waiting on an error
            self.log(f"net: error during {reason}: {e!r}")
        finally:
            if reason in ("connect", "disconnect"):
                try:
                    open(base + ".done", "wb").close()
                except OSError:
                    pass
