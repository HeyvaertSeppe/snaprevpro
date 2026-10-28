/*
 * snapvpn-hook.exe - replaces Windows Script Host for openconnect.
 *
 * openconnect normally configures the tunnel by running vpnc-script-win.js
 * through cscript.exe. That depends on Windows Script Host, which is broken
 * or disabled on some PCs. Our openconnect build is patched to run this
 * helper instead. The helper only passes the tunnel settings to SnapVPN,
 * which applies them itself:
 *
 *   1. openconnect runs us with the settings in our environment
 *      (reason=connect, INTERNAL_IP4_ADDRESS=..., TUNIDX=..., ...).
 *   2. We write the whole environment, NUL-separated and UTF-8, to
 *      %SNAPVPN_HOOK_DIR%\<n>-<reason>.env.
 *   3. For connect/disconnect we wait (max 9 s, openconnect allows 10)
 *      until SnapVPN creates <n>-<reason>.done, so the network is ready
 *      before openconnect carries on.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static int write_env(const wchar_t *path)
{
	FILE *f = _wfopen(path, L"wb");
	LPWCH env, p;

	if (!f)
		return 0;
	env = GetEnvironmentStringsW();
	for (p = env; p && *p; p += wcslen(p) + 1) {
		int n;
		char *buf;

		if (*p == L'=')	/* hidden per-drive variables like "=C:" */
			continue;
		n = WideCharToMultiByte(CP_UTF8, 0, p, -1, NULL, 0, NULL, NULL);
		if (n <= 0 || !(buf = malloc(n)))
			continue;
		WideCharToMultiByte(CP_UTF8, 0, p, -1, buf, n, NULL, NULL);
		fwrite(buf, 1, n, f);	/* includes the terminating NUL */
		free(buf);
	}
	if (env)
		FreeEnvironmentStringsW(env);
	return fclose(f) == 0;
}

int wmain(void)
{
	wchar_t dir[MAX_PATH], reason[64], base[MAX_PATH + 100];
	wchar_t tmp[MAX_PATH + 110], env_path[MAX_PATH + 110], done[MAX_PATH + 110];
	int i;

	if (!GetEnvironmentVariableW(L"SNAPVPN_HOOK_DIR", dir, MAX_PATH))
		return 0;	/* not started by SnapVPN: nothing to do */
	if (!GetEnvironmentVariableW(L"reason", reason, 64))
		return 0;

	/* Unique, sortable name so SnapVPN handles events in order. */
	swprintf(base, MAX_PATH + 100, L"%ls\\%010lu%05lu-%ls", dir,
		 (unsigned long)GetTickCount(), (unsigned long)(GetCurrentProcessId() % 100000), reason);
	swprintf(tmp, MAX_PATH + 110, L"%ls.tmp", base);
	swprintf(env_path, MAX_PATH + 110, L"%ls.env", base);
	swprintf(done, MAX_PATH + 110, L"%ls.done", base);

	if (!write_env(tmp) || !MoveFileExW(tmp, env_path, MOVEFILE_REPLACE_EXISTING))
		return 1;

	if (wcscmp(reason, L"connect") && wcscmp(reason, L"disconnect"))
		return 0;

	for (i = 0; i < 90; i++) {
		if (GetFileAttributesW(done) != INVALID_FILE_ATTRIBUTES) {
			DeleteFileW(done);
			return 0;
		}
		Sleep(100);
	}
	return 0;	/* SnapVPN didn't answer in time; let openconnect carry on */
}
