"""Windows DPAPI (CryptProtectData) via ctypes.

Data is encrypted with the current Windows user's key, so only the same
Windows account on the same machine can decrypt it.
"""

import ctypes
from ctypes import wintypes

CRYPTPROTECT_UI_FORBIDDEN = 0x01
# Extra entropy ties the blob to this app: other DPAPI users on the same
# account can't trivially decrypt it without knowing this value.
_ENTROPY = b"BSD46-VPN/password/v1"


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buf = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _crypt32():
    c = ctypes.WinDLL("crypt32", use_last_error=True)
    for fn in (c.CryptProtectData, c.CryptUnprotectData):
        fn.restype = wintypes.BOOL
        fn.argtypes = [
            ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.POINTER(_DataBlob),
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
        ]
    return c


def _take(out: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


def protect(data: bytes) -> bytes:
    inp, _k1 = _blob(data)
    ent, _k2 = _blob(_ENTROPY)
    out = _DataBlob()
    if not _crypt32().CryptProtectData(
        ctypes.byref(inp), None, ctypes.byref(ent), None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return _take(out)


def unprotect(data: bytes) -> bytes:
    inp, _k1 = _blob(data)
    ent, _k2 = _blob(_ENTROPY)
    out = _DataBlob()
    if not _crypt32().CryptUnprotectData(
        ctypes.byref(inp), None, ctypes.byref(ent), None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return _take(out)
