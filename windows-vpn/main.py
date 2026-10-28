"""Entry point for SnapVPN."""

import ctypes
import os
import sys
from tkinter import messagebox
import tkinter as tk

from snapvpn import instance
from snapvpn.autostart import AUTOSTART_ARG
from snapvpn.config import APP_NAME


def _is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _relaunch_as_admin() -> bool:
    """Only needed when running from source; the .exe always asks for admin."""
    if getattr(sys, "frozen", False):
        exe, args = sys.executable, sys.argv[1:]
    else:
        exe, args = sys.executable, [os.path.abspath(sys.argv[0]), *sys.argv[1:]]
    params = " ".join(f'"{a}"' for a in args)
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, None, 1)
    return rc > 32


def main() -> int:
    if os.name != "nt":
        print(f"{APP_NAME} only runs on Windows.")
        return 1

    if not _is_admin():
        if _relaunch_as_admin():
            return 0
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(APP_NAME, "Administrator rights are needed to create the VPN adapter.")
        return 1

    if not instance.acquire():
        return 0  # the running copy has been asked to show its window

    from snapvpn.app import App

    app = App(start_hidden=AUTOSTART_ARG in sys.argv)
    app.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
