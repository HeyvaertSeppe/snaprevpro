"""Runs openconnect.exe and keeps the tunnel up.

The controller owns one background thread. While the user wants to be
connected it starts openconnect, watches its output to work out the state,
and restarts it with a back-off whenever it exits (auto-reconnect). A wrong
password stops the loop so we don't hammer the server.
"""

import ctypes
import enum
import os
import re
import subprocess
import threading
import time
from ctypes import wintypes
from typing import Callable

from . import netfix
from .config import ADAPTER_NAME, SERVER, USERNAME, openconnect_dir


class State(enum.Enum):
    DISCONNECTED = "Disconnected"
    CONNECTING = "Connecting…"
    CONNECTED = "Connected"
    RECONNECTING = "Reconnecting…"
    DISCONNECTING = "Disconnecting…"


# Seconds to wait before each successive reconnect attempt.
_BACKOFF = [2, 3, 5, 10, 15, 30]
# A session that stayed up this long resets the back-off.
_STABLE_SECONDS = 60

_RE_CONFIGURED = re.compile(r"Configured as ([0-9a-fA-F.:]+)")
_RE_CONNECTED = re.compile(r"CSTP connected|Established DTLS connection|ESP session established")
_RE_DROPPED = re.compile(
    r"Dead Peer Detection detected dead peer|Reconnect|Failed to reconnect|"
    r"SSL read error|Server closed connection|Error receiving|Error sending",
    re.IGNORECASE,
)
_RE_AUTH_FAILED = re.compile(
    r"User input required in non-interactive mode|Login failed|Authentication failed|"
    r"Invalid (username|password|credentials)|Wrong password|Access denied",
    re.IGNORECASE,
)
_RE_CERT = re.compile(r"certificate.*(verify|invalid|untrusted|expired)|Server certificate", re.IGNORECASE)

_CREATE_NO_WINDOW = 0x08000000
_CTRL_C_EVENT = 0


# --- Windows helpers -------------------------------------------------------

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if os.name == "nt" else None


class _JobLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _ExtJobLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _make_kill_on_close_job():
    """A job object that kills openconnect if this app dies unexpectedly."""
    if _kernel32 is None:
        return None
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    job = _kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _ExtJobLimits()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    _kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
    return job


_console_lock = threading.Lock()


def _send_ctrl_c(pid: int) -> bool:
    """Ask openconnect to log out cleanly, like pressing Ctrl+C in its console.

    openconnect runs in its own hidden console. We briefly attach to it,
    send Ctrl+C (ignoring it ourselves), then detach. openconnect then runs
    its disconnect script, which restores routes and DNS.
    """
    if _kernel32 is None:
        return False
    with _console_lock:
        _kernel32.FreeConsole()
        if not _kernel32.AttachConsole(pid):
            return False
        _kernel32.SetConsoleCtrlHandler(None, True)
        try:
            ok = bool(_kernel32.GenerateConsoleCtrlEvent(_CTRL_C_EVENT, 0))
        finally:
            _kernel32.FreeConsole()
        # Give the event time to be delivered before we stop ignoring Ctrl+C;
        # the "ignore" flag would otherwise be inherited by the next openconnect.
        time.sleep(0.3)
        _kernel32.SetConsoleCtrlHandler(None, False)
        return ok


# --- controller ------------------------------------------------------------

class VpnController:
    """Thread-safe front end. Callbacks fire on the worker thread."""

    def __init__(
        self,
        on_state: Callable[[State, str], None],
        on_log: Callable[[str], None],
        on_auth_failed: Callable[[str], None],
    ):
        self._on_state = on_state
        self._on_log = on_log
        self._on_auth_failed = on_auth_failed
        self._lock = threading.Lock()
        self._want = False
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._proc: subprocess.Popen | None = None
        self._password = ""
        self._job = _make_kill_on_close_job()
        self.state = State.DISCONNECTED
        self.ip = ""
        self.connected_since: float | None = None

    # -- public API --

    def connect(self, password: str) -> None:
        with self._lock:
            self._password = password
            self._want = True
            self._wake.clear()
            if self._thread is not None:
                return  # worker already running; it picks up _want
            self._thread = threading.Thread(target=self._run, name="vpn-worker", daemon=True)
            self._thread.start()

    def disconnect(self, wait: float = 0) -> None:
        with self._lock:
            self._want = False
            self._wake.set()
            proc = self._proc
            thread = self._thread
        if proc and proc.poll() is None:
            self._set_state(State.DISCONNECTING)
            threading.Thread(target=self._stop_process, args=(proc,), daemon=True).start()
        if wait and thread:
            thread.join(wait)

    @property
    def wants_connection(self) -> bool:
        return self._want

    # -- internals --

    def _set_state(self, state: State, detail: str = "") -> None:
        self.state = state
        if state == State.CONNECTED:
            if self.connected_since is None:
                self.connected_since = time.time()
        else:
            self.connected_since = None
        self._on_state(state, detail)

    def _log(self, line: str) -> None:
        self._on_log(line)

    def _stop_process(self, proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return
        if _send_ctrl_c(proc.pid):
            try:
                proc.wait(10)
                return
            except subprocess.TimeoutExpired:
                self._log("openconnect did not exit after Ctrl+C, terminating it.")
        try:
            proc.kill()
        except OSError:
            pass

    def _command(self) -> list[str]:
        base = openconnect_dir()
        return [
            os.path.join(base, "openconnect.exe"),
            "--protocol=anyconnect",
            f"--user={USERNAME}",
            "--passwd-on-stdin",
            "--non-inter",
            f"--interface={ADAPTER_NAME}",
            "--script", os.path.join(base, "vpnc-script-win.js"),
            # openconnect retries a dropped session itself for this long;
            # after that it exits and our loop starts a fresh session.
            "--reconnect-timeout=60",
            SERVER,
        ]

    def _run(self) -> None:
        while True:
            try:
                self._session_loop()
            except Exception as e:  # never let the worker die silently
                self._log(f"Internal error: {e!r}")
                self._want = False
            self.ip = ""
            self._set_state(State.DISCONNECTED)
            with self._lock:
                if not self._want:
                    self._thread = None
                    return
            # connect() was called while we were shutting down: go again.

    def _session_loop(self) -> None:
        attempt = 0
        while self._want:
            self._set_state(State.CONNECTING if attempt == 0 else State.RECONNECTING)
            started = time.time()
            result = self._run_once()
            if not self._want:
                break
            if result == "auth":
                self._want = False
                break
            if self.ip and time.time() - started > _STABLE_SECONDS:
                attempt = 0
            delay = _BACKOFF[min(attempt, len(_BACKOFF) - 1)]
            attempt += 1
            self.ip = ""
            self._set_state(State.RECONNECTING, f"Retrying in {delay}s")
            self._log(f"Connection lost. Reconnecting in {delay}s (attempt {attempt}).")
            self._wake.wait(delay)

    def _run_once(self) -> str:
        """Run one openconnect session. Returns 'auth', 'exit' or 'error'."""
        cmd = self._command()
        exe = cmd[0]
        if not os.path.isfile(exe):
            self._log(f"openconnect.exe not found at {exe}")
            return "error"
        self._log(f"Connecting to {SERVER} as {USERNAME}…")
        # Have the routing script log what it does, so it shows up in our log.
        env = dict(os.environ, LOG2FILE="1")
        script_log_offset = netfix.script_log_size()
        session_over = threading.Event()
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=os.path.dirname(exe),
                env=env,
                creationflags=_CREATE_NO_WINDOW,
            )
        except OSError as e:
            self._log(f"Failed to start openconnect: {e}")
            return "error"

        if self._job:
            _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            _kernel32.AssignProcessToJobObject(self._job, int(proc._handle))  # noqa: SLF001

        with self._lock:
            self._proc = proc
            want = self._want
        if not want:  # disconnect() raced with start-up
            self._stop_process(proc)

        try:
            proc.stdin.write((self._password + "\n").encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass

        auth_failed = False
        last_error = ""
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            self._log(line)
            m = _RE_CONFIGURED.search(line)
            if m:
                self.ip = m.group(1)
                self._set_state(State.CONNECTED, self.ip)
                # The routing script has finished by the time this is printed.
                for script_line in netfix.read_script_log(script_log_offset):
                    self._log(script_line)
                script_log_offset = netfix.script_log_size()
                threading.Thread(
                    target=netfix.after_connect,
                    args=(ADAPTER_NAME, self._log, session_over.wait),
                    name="netfix", daemon=True,
                ).start()
                continue
            if _RE_CONNECTED.search(line) and self.state == State.RECONNECTING and self.ip:
                self._set_state(State.CONNECTED, self.ip)
                continue
            if _RE_AUTH_FAILED.search(line):
                auth_failed = True
                last_error = line
            elif _RE_CERT.search(line) and "fail" in line.lower():
                last_error = line
            if self.state == State.CONNECTED and _RE_DROPPED.search(line) and self._want:
                self._set_state(State.RECONNECTING, "Connection interrupted")

        code = proc.wait()
        session_over.set()
        with self._lock:
            self._proc = None
        self._log(f"openconnect exited (code {code}).")

        if not self._want:
            return "exit"
        if auth_failed:
            self._on_auth_failed(last_error or "Login failed")
            return "auth"
        return "error"
