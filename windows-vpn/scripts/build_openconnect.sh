#!/usr/bin/env bash
# Builds openconnect.exe for Windows and stages everything the app bundles
# into windows-vpn/vendor/openconnect:
#   openconnect.exe + all its DLLs, wintun.dll, vpnc-script-win.js
#
# Run inside an MSYS2 UCRT64 shell (the GitHub workflow does this).
set -euo pipefail

OC_VERSION="${OC_VERSION:-v9.12}"
WINTUN_VERSION="0.14.1"
WINTUN_SHA256="07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51"
VPNC_SCRIPTS_COMMIT="6cdb2fe2d75be324564fe27ff85a5e1bb17a66b0"
VPNC_SCRIPT_SHA256="e196fdf0cc8b325180154535f843034dc0ae9eb43ead9980adfcfc57c58069b2"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/openconnect"
WORK="$ROOT/build/oc-src"
PREFIX="$ROOT/build/oc-install"

rm -rf "$OUT" "$WORK" "$PREFIX"
mkdir -p "$OUT" "$WORK"

echo "::group::Build OpenConnect $OC_VERSION"
git clone --depth 1 --branch "$OC_VERSION" https://gitlab.com/openconnect/openconnect.git "$WORK/openconnect"
cd "$WORK/openconnect"
# Newer mingw-w64 headers dropped <sec_api/stdlib_s.h>; <stdlib.h> already
# provides errno_t/size_t, which is all compat.c needed it for.
sed -i "s|<sec_api/stdlib_s.h>|<stdlib.h>|" compat.c configure.ac
./autogen.sh
# GCC 14+ turned some long-standing warnings into errors, and GCC 15
# defaults to C23. OpenConnect 9.12 predates both, so build it the way it
# was written to be built.
export CFLAGS="-O2 -std=gnu17 -Wno-error=incompatible-pointer-types -Wno-error=int-conversion -Wno-error=implicit-function-declaration"
./configure \
  --prefix="$PREFIX" \
  --with-gnutls \
  --without-gnutls-version-check \
  --with-vpnc-script=vpnc-script-win.js \
  --disable-nls \
  --disable-docs \
  --disable-dsa-tests \
  --without-libproxy \
  --without-stoken \
  --without-libpskc \
  --without-libpcsclite \
  --without-gssapi \
  --without-java
make -j"$(nproc)"
make install
echo "::endgroup::"

echo "::group::Stage binaries"
cp "$PREFIX/sbin/openconnect.exe" "$OUT/"
cp "$PREFIX"/bin/*.dll "$OUT/"

# Copy every non-system DLL openconnect.exe depends on (ldd is recursive).
# Run twice in case a freshly copied DLL resolves differently.
for _ in 1 2; do
  ldd "$OUT/openconnect.exe" \
    | awk '{print $3}' \
    | grep -iE '^/(ucrt64|mingw64)/' \
    | sort -u \
    | while read -r dll; do cp -n "$dll" "$OUT/" || true; done
done
echo "::endgroup::"

echo "::group::Wintun $WINTUN_VERSION"
curl -fsSL --retry 4 -o "$WORK/wintun.zip" "https://www.wintun.net/builds/wintun-$WINTUN_VERSION.zip"
echo "$WINTUN_SHA256  $WORK/wintun.zip" | sha256sum -c -
unzip -q -o "$WORK/wintun.zip" -d "$WORK"
cp "$WORK/wintun/bin/amd64/wintun.dll" "$OUT/"
cp "$WORK/wintun/LICENSE.txt" "$OUT/wintun-LICENSE.txt"
echo "::endgroup::"

echo "::group::vpnc-script-win.js"
curl -fsSL --retry 4 -o "$OUT/vpnc-script-win.js" \
  "https://gitlab.com/openconnect/vpnc-scripts/-/raw/$VPNC_SCRIPTS_COMMIT/vpnc-script-win.js"
echo "$VPNC_SCRIPT_SHA256  $OUT/vpnc-script-win.js" | sha256sum -c -
echo "::endgroup::"

cp "$WORK/openconnect/COPYING.LGPL" "$OUT/openconnect-COPYING.LGPL"

echo "Staged files:"
ls -la "$OUT"

# Smoke test: the staged copy must start on its own (catches missing DLLs).
# Run with a clean PATH so it can't pick DLLs up from MSYS2.
PATH="/c/Windows/System32:/c/Windows" "$OUT/openconnect.exe" --version
