"""'Start with Windows' support.

The app has to run elevated (OpenConnect needs admin rights to create the
Wintun adapter and set routes/DNS). Windows silently skips elevated programs
listed under the registry Run key at sign-in, so a Run key entry would never
fire. Instead we register a Task Scheduler logon task with "highest
privileges", which starts the app elevated at sign-in without a UAC prompt.
Any old Run key entry is cleaned up.
"""

import os
import subprocess
import tempfile
import winreg
from xml.sax.saxutils import escape

from .config import APP_NAME, exe_path

TASK_NAME = APP_NAME
OLD_TASK_NAME = "BSD46 VPN"  # the app's name before it became SnapVPN
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_ARG = "--autostart"
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def _schtasks(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["schtasks.exe", *args], capture_output=True, text=True, creationflags=_NO_WINDOW
    )


def _current_user() -> str:
    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME", "")
    return f"{domain}\\{user}" if domain else user


def _task_xml(command: str) -> str:
    user = escape(_current_user())
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts {escape(APP_NAME)} in the tray when you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT5S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(command)}</Command>
      <Arguments>{AUTOSTART_ARG}</Arguments>
    </Exec>
  </Actions>
</Task>
"""


def _remove_run_key() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, APP_NAME)
    except OSError:
        pass


def is_enabled() -> bool:
    return _schtasks("/Query", "/TN", TASK_NAME).returncode == 0


def enable() -> None:
    fd, path = tempfile.mkstemp(suffix=".xml")
    try:
        with os.fdopen(fd, "w", encoding="utf-16") as f:
            f.write(_task_xml(exe_path()))
        res = _schtasks("/Create", "/TN", TASK_NAME, "/XML", path, "/F")
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout).strip() or "schtasks failed")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    _remove_run_key()


def disable() -> None:
    if is_enabled():
        res = _schtasks("/Delete", "/TN", TASK_NAME, "/F")
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout).strip() or "schtasks failed")
    _remove_run_key()


def refresh_if_enabled() -> None:
    """Re-register the task so it follows the .exe if it was moved."""
    if _schtasks("/Query", "/TN", OLD_TASK_NAME).returncode == 0:
        # Replace the task from before the rename with one under the new name.
        _schtasks("/Delete", "/TN", OLD_TASK_NAME, "/F")
        try:
            enable()
        except Exception:
            pass
        return
    if is_enabled():
        try:
            enable()
        except Exception:
            pass
