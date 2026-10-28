"""System tray icon. Menu actions are forwarded to the UI thread."""

import threading
from typing import Callable

import pystray

from .config import APP_NAME
from .icons import make_icon
from .vpn import State

_STATUS_KEY = {
    State.CONNECTED: "connected",
    State.CONNECTING: "busy",
    State.RECONNECTING: "busy",
    State.DISCONNECTING: "busy",
    State.DISCONNECTED: "disconnected",
}


class Tray:
    def __init__(self, post: Callable[[str], None]):
        """`post(action)` is called from the tray thread with
        'show', 'connect', 'disconnect' or 'quit'."""
        self._post = post
        self._state = State.DISCONNECTED
        self._detail = ""
        self._images = {k: make_icon(64, k) for k in set(_STATUS_KEY.values()) | {"error"}}
        menu = pystray.Menu(
            pystray.MenuItem("Open " + APP_NAME, lambda: post("show"), default=True),
            pystray.MenuItem(lambda _i: self._status_text(), None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Connect", lambda: post("connect"),
                             enabled=lambda _i: self._state == State.DISCONNECTED),
            pystray.MenuItem("Disconnect", lambda: post("disconnect"),
                             enabled=lambda _i: self._state != State.DISCONNECTED),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda: post("quit")),
        )
        self._icon = pystray.Icon("snapvpn", self._images["disconnected"], APP_NAME, menu)
        self._thread = threading.Thread(target=self._icon.run, name="tray", daemon=True)

    def _status_text(self) -> str:
        text = self._state.value
        if self._state == State.CONNECTED and self._detail:
            text += f" ({self._detail})"
        return text

    def start(self) -> None:
        self._thread.start()

    def set_state(self, state: State, detail: str = "", error: bool = False) -> None:
        self._state = state
        self._detail = detail
        key = "error" if error else _STATUS_KEY[state]
        try:
            self._icon.icon = self._images[key]
            self._icon.title = f"{APP_NAME} - {self._status_text()}"
            self._icon.update_menu()
        except Exception:
            pass  # tray not ready yet

    def notify(self, message: str, title: str = APP_NAME) -> None:
        try:
            self._icon.notify(message, title)
        except Exception:
            pass

    def stop(self) -> None:
        try:
            self._icon.stop()
        except Exception:
            pass
