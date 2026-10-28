# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: one portable, self-elevating .exe with OpenConnect,
# its DLLs, Wintun and the routing script bundled inside.
#
# Build (from windows-vpn/):  pyinstaller --noconfirm SnapVPN.spec

import os
from PyInstaller.utils.hooks import collect_data_files

if not os.path.isfile(os.path.join("vendor", "openconnect", "openconnect.exe")):
    raise SystemExit("vendor/openconnect is missing - run scripts/build_openconnect.sh first")

datas = collect_data_files("customtkinter") + [
    ("vendor/openconnect", "openconnect"),
    ("assets/app.ico", "assets"),
]

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=["pystray._win32", "PIL._tkinter_finder"],
    excludes=["numpy", "pandas", "matplotlib", "PyQt5", "PySide6", "unittest", "pydoc"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="SnapVPN",
    icon="assets/app.ico",
    version="version_info.txt",
    console=False,
    uac_admin=True,
    upx=False,  # UPX-packed executables trip antivirus far more often
    debug=False,
    strip=False,
    runtime_tmpdir=None,
)
