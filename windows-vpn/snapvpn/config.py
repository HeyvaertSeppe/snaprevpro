"""Fixed connection details, file locations and the saved settings file."""

import base64
import json
import os
import sys
from dataclasses import asdict, dataclass

from . import dpapi

APP_NAME = "SnapVPN"
SERVER = "bsd46.heyvaertseppe.qzz.io"
USERNAME = "bypass"
# Name of the Wintun network adapter that shows up in Windows.
ADAPTER_NAME = "SnapVPN"

_APPDATA = os.environ.get("APPDATA") or os.path.expanduser("~")
DATA_DIR = os.path.join(_APPDATA, APP_NAME)
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
# Where settings lived before the app was renamed to SnapVPN.
OLD_SETTINGS_FILE = os.path.join(_APPDATA, "BSD46 VPN", "settings.json")
LOG_FILE = os.path.join(DATA_DIR, "vpn.log")


def resource_path(*parts: str) -> str:
    """Path to a file bundled inside the .exe (or next to the sources in dev)."""
    base = getattr(sys, "_MEIPASS", None)
    if base is None:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def openconnect_dir() -> str:
    """Folder holding openconnect.exe, its DLLs, wintun.dll and the route script."""
    bundled = resource_path("openconnect")
    if os.path.isdir(bundled):
        return bundled
    # Dev fallback: a locally built copy in windows-vpn/vendor/openconnect.
    return resource_path("vendor", "openconnect")


def exe_path() -> str:
    """The path Windows should launch for auto-start."""
    if getattr(sys, "frozen", False):
        return sys.executable
    return os.path.abspath(sys.argv[0])


@dataclass
class Settings:
    remember_password: bool = False
    # DPAPI-encrypted password, base64 encoded. Never stored in plain text.
    password_blob: str = ""

    @classmethod
    def load(cls) -> "Settings":
        path = SETTINGS_FILE
        if not os.path.exists(path) and os.path.exists(OLD_SETTINGS_FILE):
            path = OLD_SETTINGS_FILE  # carry over the saved password after the rename
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            return cls()
        known = {k: raw[k] for k in cls.__dataclass_fields__ if k in raw}
        return cls(**known)

    def save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)
        os.replace(tmp, SETTINGS_FILE)

    # --- password helpers -------------------------------------------------

    def get_password(self) -> str | None:
        if not self.password_blob:
            return None
        try:
            data = dpapi.unprotect(base64.b64decode(self.password_blob))
            return data.decode("utf-8")
        except Exception:
            # Blob from another Windows account/PC, or corrupted: ignore it.
            return None

    def set_password(self, password: str) -> None:
        blob = dpapi.protect(password.encode("utf-8"))
        self.password_blob = base64.b64encode(blob).decode("ascii")
        self.remember_password = True

    def forget_password(self) -> None:
        self.password_blob = ""
        self.remember_password = False
