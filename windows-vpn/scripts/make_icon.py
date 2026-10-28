"""Generates assets/app.ico (used for the .exe and window icon)."""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from bsd46vpn.icons import save_ico  # noqa: E402

out = os.path.join(ROOT, "assets", "app.ico")
os.makedirs(os.path.dirname(out), exist_ok=True)
save_ico(out)
print("wrote", out)
