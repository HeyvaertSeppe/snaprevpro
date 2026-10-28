"""Shows "Connected using SnapVPN" when Snapchat Web comes to the front.

We can't (and shouldn't) change the Snapchat page itself: it's encrypted
HTTPS. Instead we watch the foreground window. When a browser shows a
Snapchat tab while the VPN is connected, a small card appears over the
browser for a few seconds. Disconnected (or SnapVPN not running), nothing
is shown.
"""

import ctypes
import os
import re
import time
import tkinter as tk
from ctypes import wintypes
from typing import Callable

import customtkinter as ctk

from .icons import make_icon

_BROWSERS = {
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe",
    "opera_gx.exe", "vivaldi.exe", "arc.exe", "librewolf.exe", "waterfox.exe",
}
# web.snapchat.com titles its tab "Snapchat" (with an unread count like "(2)").
_SNAP_TITLE = re.compile(r"^(\(\d+\)\s*)?Snapchat(\s+Web)?\s*([-–—|]|$)")
# ...but a search for "Snapchat" is not Snapchat Web.
_NOT_SNAP = re.compile(r"Google (Search|Zoeken|zoeken)|Bing|DuckDuckGo|Ecosia|Yahoo|Zoeken|Search|Download")
# Don't show it again if Snapchat was in front this recently (tab switching).
_QUIET_SECONDS = 60
_POLL_MS = 700

_TRANSPARENT = "#010203"
CARD = "#161922"
BORDER = "#242836"
GREEN = "#22c55e"
TEXT = "#e6e8ee"
MUTED = "#8b91a1"

if os.name == "nt":
    _user32 = ctypes.WinDLL("user32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    _user32.GetParent.argtypes = [wintypes.HWND]
    _user32.GetParent.restype = wintypes.HWND
    _user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    _user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def _foreground() -> tuple[int, str, str]:
    """(window handle, title, lowercase process name) of the window in front."""
    hwnd = _user32.GetForegroundWindow()
    if not hwnd:
        return 0, "", ""
    n = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    _user32.GetWindowTextW(hwnd, buf, n + 1)
    pid = wintypes.DWORD()
    _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    exe = ""
    h = _kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if h:
        size = wintypes.DWORD(1024)
        path = ctypes.create_unicode_buffer(size.value)
        if _kernel32.QueryFullProcessImageNameW(h, 0, path, ctypes.byref(size)):
            exe = os.path.basename(path.value).lower()
        _kernel32.CloseHandle(h)
    return hwnd, buf.value, exe


def is_snapchat_web(title: str, exe: str) -> bool:
    return exe in _BROWSERS and bool(_SNAP_TITLE.search(title)) and not _NOT_SNAP.search(title)


class SnapchatWatcher:
    def __init__(self, root: ctk.CTk, is_connected: Callable[[], bool]):
        self.root = root
        self.is_connected = is_connected
        self._was_in_front = False
        self._last_seen = 0.0
        self._toast: "Toast | None" = None

    def start(self) -> None:
        if os.name == "nt":
            self.root.after(_POLL_MS, self._poll)

    def _poll(self) -> None:
        try:
            hwnd, title, exe = _foreground()
            in_front = is_snapchat_web(title, exe)
            now = time.monotonic()
            if in_front and not self._was_in_front and now - self._last_seen > _QUIET_SECONDS:
                if self.is_connected():
                    self.show(hwnd)
            if in_front:
                self._last_seen = now
            self._was_in_front = in_front
        except Exception:
            pass
        self.root.after(_POLL_MS, self._poll)

    def show(self, over_hwnd: int = 0) -> None:
        if self._toast is not None:
            self._toast.close()
        self._toast = Toast(self.root, over_hwnd)


class Toast(tk.Toplevel):
    """A small rounded card that fades in and out without taking focus."""

    WIDTH, HEIGHT = 330, 74

    def __init__(self, root: tk.Misc, over_hwnd: int):
        super().__init__(root, bg=_TRANSPARENT)
        self.withdraw()
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        try:
            self.attributes("-transparentcolor", _TRANSPARENT)
        except tk.TclError:
            pass
        self.attributes("-alpha", 0.0)

        card = ctk.CTkFrame(self, width=self.WIDTH, height=self.HEIGHT, corner_radius=18,
                            fg_color=CARD, border_width=1, border_color=BORDER,
                            bg_color=_TRANSPARENT)
        card.pack()
        card.pack_propagate(False)
        icon = ctk.CTkImage(make_icon(96, "connected"), size=(38, 38))
        ctk.CTkLabel(card, text="", image=icon).place(x=18, rely=0.5, anchor="w")
        ctk.CTkLabel(card, text="Connected using SnapVPN", text_color=TEXT,
                     font=ctk.CTkFont(family="Segoe UI", size=15, weight="bold")).place(x=68, y=14)
        ctk.CTkLabel(card, text="Your connection is protected", text_color=GREEN,
                     font=ctk.CTkFont(family="Segoe UI", size=12)).place(x=68, y=40)
        for w in (self, card, *card.winfo_children()):
            w.bind("<Button-1>", lambda _e: self.close())

        x, y = self._position(over_hwnd)
        self.geometry(f"+{x}+{y}")
        self._prev = over_hwnd
        self._closing = False
        self.update_idletasks()
        self._no_activate()
        self.deiconify()
        self._give_back_focus()
        self._fade(0.0, 0.96, 0.12, then=lambda: self.after(4500, self.close))

    def _position(self, over_hwnd: int) -> tuple[int, int]:
        """Top-centre of the browser window, just below its address bar."""
        if os.name == "nt" and over_hwnd:
            r = wintypes.RECT()
            if _user32.GetWindowRect(over_hwnd, ctypes.byref(r)) and r.right - r.left > self.WIDTH:
                return (r.left + r.right) // 2 - self.WIDTH // 2, max(r.top, 0) + 110
        sw = self.winfo_screenwidth()
        return sw // 2 - self.WIDTH // 2, 110

    def _no_activate(self) -> None:
        if os.name != "nt":
            return
        hwnd = _user32.GetParent(self.winfo_id()) or self.winfo_id()
        GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW = -20, 0x08000000, 0x00000080
        style = _user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        _user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)

    def _give_back_focus(self) -> None:
        # If showing the card took focus anyway, hand it straight back.
        if os.name == "nt" and self._prev and _user32.GetForegroundWindow() != self._prev:
            _user32.SetForegroundWindow(self._prev)

    def _fade(self, alpha: float, target: float, step: float, then: Callable[[], None] | None = None) -> None:
        try:
            if not self.winfo_exists():
                return
            alpha = min(target, alpha + step) if step > 0 else max(target, alpha + step)
            self.attributes("-alpha", alpha)
            if alpha != target:
                self.after(20, lambda: self._fade(alpha, target, step, then))
            elif then:
                then()
        except tk.TclError:
            pass

    def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        try:
            start = float(self.attributes("-alpha"))
        except tk.TclError:
            start = 0.0
        self._fade(start, 0.0, -0.12, then=self.destroy)
