"""Single-instance guard. A second launch asks the running app to show itself."""

import ctypes
import threading
from ctypes import wintypes
from typing import Callable

_MUTEX_NAME = "Local\\BSD46VPN.SingleInstance"
_EVENT_NAME = "Local\\BSD46VPN.ShowWindow"
_ERROR_ALREADY_EXISTS = 183
_INFINITE = 0xFFFFFFFF

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateMutexW.restype = wintypes.HANDLE
_k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
_k32.CreateEventW.restype = wintypes.HANDLE
_k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
_k32.SetEvent.argtypes = [wintypes.HANDLE]
_k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]

_handles = []  # keep handles alive for the life of the process


def acquire() -> bool:
    """True if we are the first instance. Otherwise signals the first one."""
    mutex = _k32.CreateMutexW(None, False, _MUTEX_NAME)
    already = ctypes.get_last_error() == _ERROR_ALREADY_EXISTS
    _handles.append(mutex)
    event = _k32.CreateEventW(None, False, False, _EVENT_NAME)
    _handles.append(event)
    if already:
        if event:
            _k32.SetEvent(event)
        return False
    return True


def listen(on_show: Callable[[], None]) -> None:
    """Call `on_show` (from a background thread) whenever another launch happens."""
    event = _handles[-1] if _handles else None
    if not event:
        return

    def wait() -> None:
        while True:
            if _k32.WaitForSingleObject(event, _INFINITE) == 0:
                on_show()

    threading.Thread(target=wait, name="instance-listener", daemon=True).start()
