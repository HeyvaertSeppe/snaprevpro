"""Main window (customtkinter) and the glue between UI, VPN and tray."""

import collections
import os
import queue
import time
import tkinter as tk
from tkinter import messagebox

import customtkinter as ctk

from . import autostart, instance
from .config import APP_NAME, DATA_DIR, LOG_FILE, SERVER, USERNAME, Settings, resource_path
from .icons import make_icon
from .tray import Tray
from .vpn import State, VpnController

BG = "#0d0f14"
CARD = "#161922"
CARD_BORDER = "#242836"
TEXT = "#e6e8ee"
MUTED = "#8b91a1"
ACCENT = "#3b82f6"
ACCENT_HOVER = "#2563eb"
GREEN = "#22c55e"
AMBER = "#f59e0b"
RED = "#ef4444"
RED_HOVER = "#dc2626"
GREY_BTN = "#2a2f3d"
GREY_BTN_HOVER = "#353b4c"

_STATE_STYLE = {
    State.DISCONNECTED: ("disconnected", MUTED),
    State.CONNECTING: ("busy", AMBER),
    State.RECONNECTING: ("busy", AMBER),
    State.DISCONNECTING: ("busy", AMBER),
    State.CONNECTED: ("connected", GREEN),
}


def _fmt_duration(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class App(ctk.CTk):
    def __init__(self, start_hidden: bool):
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")
        super().__init__(fg_color=BG)

        self.settings = Settings.load()
        self._password = self.settings.get_password() if self.settings.remember_password else None
        self._events: queue.Queue = queue.Queue()
        self._log_lines: collections.deque[str] = collections.deque(maxlen=800)
        self._told_about_tray = False
        self._log_visible = False
        self._quitting = False
        self._open_log_file()

        self.vpn = VpnController(
            on_state=lambda st, d: self._events.put(("state", st, d)),
            on_log=lambda line: self._events.put(("log", line)),
            on_auth_failed=lambda msg: self._events.put(("auth_failed", msg)),
        )
        self.tray = Tray(post=lambda action: self._events.put(("action", action)))

        self._build_window()
        self._apply_state(State.DISCONNECTED, "")
        self._refresh_password_ui()

        instance.listen(lambda: self._events.put(("action", "show")))
        self.tray.start()
        self.after(50, self._pump)
        self.after(1000, self._tick)

        # Auto-connect as soon as we have a password.
        if self._password:
            self.vpn.connect(self._password)
            if start_hidden:
                self.withdraw()
        else:
            self.after(150, lambda: self.pw_entry.focus_set())

        # Keep the auto-start task pointing at this .exe if it was moved.
        self.after(2000, autostart.refresh_if_enabled)

    # ------------------------------------------------------------------ UI

    def _build_window(self) -> None:
        self.title(APP_NAME)
        self.geometry("400x560")
        self.resizable(False, False)
        try:
            self.iconbitmap(resource_path("assets", "app.ico"))
        except tk.TclError:
            pass
        self.protocol("WM_DELETE_WINDOW", self._hide_to_tray)
        self.grid_columnconfigure(0, weight=1)

        title_font = ctk.CTkFont(family="Segoe UI", size=20, weight="bold")
        big_font = ctk.CTkFont(family="Segoe UI", size=22, weight="bold")
        body_font = ctk.CTkFont(family="Segoe UI", size=13)
        small_font = ctk.CTkFont(family="Segoe UI", size=12)
        btn_font = ctk.CTkFont(family="Segoe UI", size=15, weight="bold")

        # Header
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=22, pady=(20, 8))
        logo = ctk.CTkImage(make_icon(64), size=(30, 30))
        ctk.CTkLabel(header, image=logo, text="").pack(side="left")
        ctk.CTkLabel(header, text=APP_NAME, font=title_font, text_color=TEXT).pack(side="left", padx=(10, 0))

        # Status card
        card = ctk.CTkFrame(self, fg_color=CARD, corner_radius=18, border_width=1, border_color=CARD_BORDER)
        card.grid(row=1, column=0, sticky="ew", padx=22, pady=8)
        card.grid_columnconfigure(0, weight=1)
        self._status_images = {k: ctk.CTkImage(make_icon(192, k), size=(96, 96))
                               for k in ("connected", "busy", "disconnected", "error")}
        self.status_icon = ctk.CTkLabel(card, text="", image=self._status_images["disconnected"])
        self.status_icon.grid(row=0, column=0, pady=(22, 6))
        self.status_label = ctk.CTkLabel(card, text="Disconnected", font=big_font, text_color=TEXT)
        self.status_label.grid(row=1, column=0)
        self.detail_label = ctk.CTkLabel(card, text="", font=body_font, text_color=MUTED)
        self.detail_label.grid(row=2, column=0, pady=(0, 14))

        info = ctk.CTkFrame(card, fg_color="transparent")
        info.grid(row=3, column=0, sticky="ew", padx=20, pady=(0, 18))
        info.grid_columnconfigure(1, weight=1)
        self._info_values = {}
        for i, (key, value) in enumerate((("Server", SERVER), ("User", USERNAME), ("VPN IP", "–"), ("Uptime", "–"))):
            ctk.CTkLabel(info, text=key, font=small_font, text_color=MUTED).grid(row=i, column=0, sticky="w", pady=1)
            lbl = ctk.CTkLabel(info, text=value, font=small_font, text_color=TEXT)
            lbl.grid(row=i, column=1, sticky="e", pady=1)
            self._info_values[key] = lbl

        # Password card (only when we have no password)
        self.pw_card = ctk.CTkFrame(self, fg_color=CARD, corner_radius=18, border_width=1, border_color=CARD_BORDER)
        self.pw_card.grid(row=2, column=0, sticky="ew", padx=22, pady=8)
        self.pw_card.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(self.pw_card, text="Password", font=small_font, text_color=MUTED).grid(
            row=0, column=0, sticky="w", padx=18, pady=(14, 2))
        self.pw_entry = ctk.CTkEntry(self.pw_card, show="•", height=38, corner_radius=10, font=body_font,
                                     placeholder_text=f"Password for {USERNAME}",
                                     fg_color="#0f1219", border_color=CARD_BORDER)
        self.pw_entry.grid(row=1, column=0, sticky="ew", padx=18)
        self.pw_entry.bind("<Return>", lambda _e: self._on_main_button())
        self.remember_var = tk.BooleanVar(value=True)
        ctk.CTkCheckBox(self.pw_card, text="Remember password", variable=self.remember_var,
                        font=small_font, text_color=TEXT, checkbox_width=18, checkbox_height=18,
                        corner_radius=5).grid(row=2, column=0, sticky="w", padx=18, pady=(10, 14))
        self.pw_error = ctk.CTkLabel(self.pw_card, text="", font=small_font, text_color=RED)
        self.pw_error.grid(row=3, column=0, sticky="w", padx=18, pady=(0, 12))

        # Main button
        self.main_button = ctk.CTkButton(self, text="Connect", height=48, corner_radius=14, font=btn_font,
                                         fg_color=ACCENT, hover_color=ACCENT_HOVER, command=self._on_main_button)
        self.main_button.grid(row=3, column=0, sticky="ew", padx=22, pady=(10, 8))

        # Settings row
        opts = ctk.CTkFrame(self, fg_color="transparent")
        opts.grid(row=4, column=0, sticky="ew", padx=22, pady=(4, 0))
        opts.grid_columnconfigure(0, weight=1)
        self.autostart_var = tk.BooleanVar(value=False)
        self.autostart_switch = ctk.CTkSwitch(opts, text="Start with Windows", variable=self.autostart_var,
                                              font=small_font, text_color=TEXT, command=self._on_autostart)
        self.autostart_switch.grid(row=0, column=0, sticky="w")
        self.after(10, lambda: self.autostart_var.set(autostart.is_enabled()))
        self.forget_button = ctk.CTkButton(opts, text="Forget password", width=10, height=26, font=small_font,
                                           fg_color="transparent", hover_color=GREY_BTN, text_color=MUTED,
                                           command=self._on_forget)
        self.forget_button.grid(row=0, column=1, sticky="e")
        self.log_button = ctk.CTkButton(opts, text="Show log", width=10, height=26, font=small_font,
                                        fg_color="transparent", hover_color=GREY_BTN, text_color=MUTED,
                                        command=self._toggle_log)
        self.log_button.grid(row=1, column=1, sticky="e", pady=(4, 0))

        # Log panel (hidden by default)
        self.grid_rowconfigure(5, weight=1)
        self.log_box = ctk.CTkTextbox(self, height=160, corner_radius=12, fg_color="#0a0c10",
                                      border_width=1, border_color=CARD_BORDER, text_color=MUTED,
                                      font=ctk.CTkFont(family="Consolas", size=11), wrap="word")
        self.log_box.configure(state="disabled")

    def _refresh_password_ui(self, error: str = "") -> None:
        if self._password and not error:
            self.pw_card.grid_remove()
        else:
            self.pw_card.grid()
        self.pw_error.configure(text=error)
        if error:
            self.pw_error.grid()
        else:
            self.pw_error.grid_remove()
        if self.settings.password_blob:
            self.forget_button.grid()
        else:
            self.forget_button.grid_remove()
        self._fit_height()

    def _apply_state(self, state: State, detail: str, error: bool = False) -> None:
        key, color = _STATE_STYLE[state]
        if error:
            key, color = "error", RED
        self.status_icon.configure(image=self._status_images[key])
        self.status_label.configure(text=state.value, text_color=TEXT if state != State.CONNECTED else GREEN)
        if state == State.CONNECTED:
            self.detail_label.configure(text="Your traffic is protected")
        elif error and detail:
            self.detail_label.configure(text=detail)
        elif state == State.DISCONNECTED:
            self.detail_label.configure(text="Not connected")
        else:
            self.detail_label.configure(text=detail or SERVER)
        self._info_values["VPN IP"].configure(text=self.vpn.ip or "–")
        if state == State.DISCONNECTED:
            self.main_button.configure(text="Connect", fg_color=ACCENT, hover_color=ACCENT_HOVER, state="normal")
        elif state == State.CONNECTED:
            self.main_button.configure(text="Disconnect", fg_color=RED, hover_color=RED_HOVER, state="normal")
        elif state == State.DISCONNECTING:
            self.main_button.configure(text="Disconnecting…", fg_color=GREY_BTN, hover_color=GREY_BTN, state="disabled")
        else:
            self.main_button.configure(text="Cancel", fg_color=GREY_BTN, hover_color=GREY_BTN_HOVER, state="normal")
        self._tick(reschedule=False)
        self.tray.set_state(state, self.vpn.ip, error=error)

    def _toggle_log(self) -> None:
        self._log_visible = not self._log_visible
        if self._log_visible:
            self.log_box.grid(row=5, column=0, sticky="nsew", padx=22, pady=(8, 18))
            self.log_button.configure(text="Hide log")
            self.log_box.see("end")
        else:
            self.log_box.grid_remove()
            self.log_button.configure(text="Show log")
        self._fit_height()

    def _fit_height(self) -> None:
        # Fixed heights (CTk applies DPI scaling to geometry() itself).
        h = 560
        if self.pw_card.winfo_manager():
            h += 150 if self.pw_error.cget("text") else 125
        if self._log_visible:
            h += 230
        self.geometry(f"400x{h}")

    # ------------------------------------------------------------ actions

    def _on_main_button(self) -> None:
        if self.vpn.state != State.DISCONNECTED or self.vpn.wants_connection:
            self.vpn.disconnect()
            return
        typed = self.pw_entry.get()
        if self.pw_card.winfo_ismapped() and typed:
            self._password = typed
            if self.remember_var.get():
                try:
                    self.settings.set_password(typed)
                except Exception as e:  # DPAPI failure: still connect, just don't save
                    self._log(f"Could not save password: {e}")
            else:
                self.settings.forget_password()
            self._save_settings()
            self.pw_entry.delete(0, "end")
        if not self._password:
            self._refresh_password_ui("Enter your password")
            self.pw_entry.focus_set()
            return
        self._refresh_password_ui()
        self.vpn.connect(self._password)

    def _on_autostart(self) -> None:
        want = bool(self.autostart_var.get())
        try:
            autostart.enable() if want else autostart.disable()
        except Exception as e:
            messagebox.showerror(APP_NAME, f"Could not change auto-start:\n{e}")
        self.autostart_var.set(autostart.is_enabled())

    def _on_forget(self) -> None:
        self.settings.forget_password()
        self._save_settings()
        self._refresh_password_ui()

    def _hide_to_tray(self) -> None:
        self.withdraw()
        if not self._told_about_tray:
            self._told_about_tray = True
            self.tray.notify(f"{APP_NAME} is still running in the tray. Right-click the icon to quit.")

    def show(self) -> None:
        self.deiconify()
        self.lift()
        self.attributes("-topmost", True)
        self.after(200, lambda: self.attributes("-topmost", False))
        self.focus_force()

    def quit_app(self) -> None:
        if self._quitting:
            return
        self._quitting = True
        self.withdraw()
        self.vpn.disconnect(wait=12)
        self.tray.stop()
        self.destroy()

    # --------------------------------------------------------- event pump

    def _pump(self) -> None:
        try:
            while True:
                ev = self._events.get_nowait()
                kind = ev[0]
                if kind == "state":
                    self._apply_state(ev[1], ev[2])
                elif kind == "log":
                    self._log(ev[1])
                elif kind == "auth_failed":
                    self._on_auth_failed(ev[1])
                elif kind == "action":
                    self._on_action(ev[1])
        except queue.Empty:
            pass
        if not self._quitting:
            self.after(50, self._pump)

    def _on_action(self, action: str) -> None:
        if action == "show":
            self.show()
        elif action == "connect":
            if self._password:
                self.vpn.connect(self._password)
            else:
                self.show()
                self.pw_entry.focus_set()
        elif action == "disconnect":
            self.vpn.disconnect()
        elif action == "quit":
            self.quit_app()

    def _on_auth_failed(self, message: str) -> None:
        self._password = None
        self._refresh_password_ui("Wrong password - please try again")
        self._apply_state(State.DISCONNECTED, "Login failed", error=True)
        self.tray.notify("Login failed. Open the app to enter your password.")
        self.show()
        self.pw_entry.focus_set()

    def _tick(self, reschedule: bool = True) -> None:
        since = self.vpn.connected_since
        if since and self.vpn.state == State.CONNECTED:
            self._info_values["Uptime"].configure(text=_fmt_duration(time.time() - since))
        else:
            self._info_values["Uptime"].configure(text="–")
        if reschedule and not self._quitting:
            self.after(1000, self._tick)

    # --------------------------------------------------------------- misc

    def _open_log_file(self) -> None:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
                os.replace(LOG_FILE, LOG_FILE + ".old")
            self._log_fh = open(LOG_FILE, "a", encoding="utf-8")
        except OSError:
            self._log_fh = None

    def _log(self, line: str) -> None:
        stamped = f"[{time.strftime('%H:%M:%S')}] {line}"
        self._log_lines.append(stamped)
        if self._log_fh:
            try:
                self._log_fh.write(time.strftime("%Y-%m-%d ") + stamped + "\n")
                self._log_fh.flush()
            except OSError:
                pass
        self.log_box.configure(state="normal")
        self.log_box.insert("end", stamped + "\n")
        if int(self.log_box.index("end-1c").split(".")[0]) > 1000:
            self.log_box.delete("1.0", "200.0")
        self.log_box.configure(state="disabled")
        if self._log_visible:
            self.log_box.see("end")

    def _save_settings(self) -> None:
        try:
            self.settings.save()
        except OSError as e:
            self._log(f"Could not save settings: {e}")
