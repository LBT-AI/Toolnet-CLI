#!/usr/bin/env bash
# Phase 8 — installer smoke (deterministic, no network, no host mutation).
#
# Exercises install.sh end-to-end against shimmed `curl`/`uname`:
#   1. OS/arch detection (linux/darwin, x64/arm64)
#   2. SHA-256 verification (match + mismatch)
#   3. safe install to the requested directory + ~/.local/bin fallback
#   4. existing-install replacement (atomic, no .tmp left behind)
#   5. failure-safe behaviour when checksums are unavailable
#   6. unsupported architecture is rejected
#   7. NO destructive PATH/rc-file modification
#
# Run: bash scripts/phase8-installer-smoke.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

command -v sha256sum >/dev/null 2>&1 && SHA="sha256sum" || SHA="shasum -a 256"

# ── shims ────────────────────────────────────────────────────────────────────
SHIM="$WORK/shim"
mkdir -p "$SHIM"

cat > "$SHIM/uname" <<'SHIM_EOF'
#!/usr/bin/env bash
case "$1" in
  -m) echo "${FAKE_UNAME_M:-x86_64}" ;;
  *)  echo "${FAKE_UNAME_S:-Linux}" ;;
esac
SHIM_EOF
chmod +x "$SHIM/uname"

cat > "$SHIM/curl" <<'SHIM_EOF'
#!/usr/bin/env bash
# Network-free curl shim: serves release metadata + fixture artifacts.
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *)  url="$1"; shift ;;
  esac
done
case "$url" in
  *releases/latest)
    printf '{"tag_name":"v%s"}\n' "${FAKE_VERSION:-1.4.0}" ;;
  *checksums.txt)
    [ "${FAKE_NO_CHECKSUMS:-0}" = "1" ] && exit 22
    cat "$FAKE_FIXTURES/checksums.txt" ;;
  *.tar.gz|*.zip)
    cat "$FAKE_FIXTURES/$(basename "$url")" ;;
  *)
    exit 22 ;;
esac > "${out:-/dev/stdout}"
SHIM_EOF
chmod +x "$SHIM/curl"

# ── fixture helpers ──────────────────────────────────────────────────────────
new_fixtures() {  # $1 = fixture dir
  rm -rf "$1"; mkdir -p "$1"
}

make_archive() {  # $1 = artifact base name (no ext), $2 = fixture dir, $3 = payload
  local name="$1" dir="$2" payload="$3"
  mkdir -p "$dir/payload"
  printf '%s' "$payload" > "$dir/payload/$name"
  ( cd "$dir/payload" && tar -czf "$dir/$name.tar.gz" "$name" )
  ( cd "$dir" && $SHA "$name.tar.gz" | awk '{print $1}' > .hash )
}

run_install() {  # $1 = log path, rest = env assignments
  local log="$1"; shift
  ( env PATH="$SHIM:$PATH" "$@" bash "$INSTALL_SH" ) >"$log" 2>&1
  echo $?
}

# ── 1. linux x64 happy path (explicit writable install dir) ──────────────────
echo "== 1. linux-x64: detect, verify, safe install =="
FIX="$WORK/fix1"; new_fixtures "$FIX"; make_archive "toolnet-linux-x64" "$FIX" "PAYLOAD-A"
HASH="$(cat "$FIX/.hash")"
printf '%s  toolnet-linux-x64.tar.gz\n' "$HASH" > "$FIX/checksums.txt"
BIN1="$WORK/good/bin"; HOME1="$WORK/good/home"; mkdir -p "$BIN1" "$HOME1"
code=$(run_install "$WORK/log1" FAKE_FIXTURES="$FIX" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 \
  TOOLNET_INSTALL_DIR="$BIN1" HOME="$HOME1")
if [ "$code" = "0" ] && [ -x "$BIN1/toolnet" ] && [ "$(cat "$BIN1/toolnet")" = "PAYLOAD-A" ]; then
  ok "installed toolnet to the requested directory"
else
  bad "install failed (exit=$code)"; sed -n '1,20p' "$WORK/log1"
fi
grep -q "Checksum verified" "$WORK/log1" && ok "SHA-256 verified" || bad "checksum step did not report success"

# ── 1b. fallback to ~/.local/bin when the requested dir is unusable ──────────
echo "== 1b. unusable install dir → safe ~/.local/bin fallback =="
HOMEFB="$WORK/fallback-home"; mkdir -p "$HOMEFB"
code=$(run_install "$WORK/log1b" FAKE_FIXTURES="$FIX" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 \
  TOOLNET_INSTALL_DIR="$WORK/missing/nested/bin" HOME="$HOMEFB")
if [ "$code" = "0" ] && [ -x "$HOMEFB/.local/bin/toolnet" ] && grep -q ".local/bin" "$WORK/log1b"; then
  ok "fell back to \$HOME/.local/bin"
else
  bad "fallback handling (exit=$code)"; sed -n '1,20p' "$WORK/log1b"
fi

# ── 2. existing install replaced atomically ──────────────────────────────────
echo "== 2. existing install is replaced (no .tmp residue) =="
printf 'OLD-BINARY' > "$BIN1/toolnet"
code=$(run_install "$WORK/log2" FAKE_FIXTURES="$FIX" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 \
  TOOLNET_INSTALL_DIR="$BIN1" HOME="$HOME1")
if [ "$code" = "0" ] && [ "$(cat "$BIN1/toolnet")" = "PAYLOAD-A" ] && ! ls "$BIN1"/*.tmp >/dev/null 2>&1; then
  ok "existing install replaced atomically"
else
  bad "existing-install handling (exit=$code)"; ls -la "$BIN1"
fi

# ── 3. checksum mismatch fails and leaves the old binary untouched ───────────
echo "== 3. checksum mismatch is rejected before install =="
FIX3="$WORK/fix3"; new_fixtures "$FIX3"
cp "$FIX/toolnet-linux-x64.tar.gz" "$FIX3/"
printf '%064d  toolnet-linux-x64.tar.gz\n' 0 > "$FIX3/checksums.txt"
BIN3="$WORK/mismatch/bin"; mkdir -p "$BIN3"; printf 'KEEP-ME' > "$BIN3/toolnet"
code=$(run_install "$WORK/log3" FAKE_FIXTURES="$FIX3" FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 \
  TOOLNET_INSTALL_DIR="$BIN3" HOME="$HOME1")
if [ "$code" != "0" ] && grep -q "SHA-256 mismatch" "$WORK/log3" && [ "$(cat "$BIN3/toolnet")" = "KEEP-ME" ]; then
  ok "mismatch rejected; existing binary untouched"
else
  bad "mismatch handling (exit=$code)"; sed -n '1,20p' "$WORK/log3"
fi

# ── 4. missing checksums → warn + proceed (failure-safe) ─────────────────────
echo "== 4. missing checksums.txt → warn, still installs =="
BIN4="$WORK/nochecksum/bin"; mkdir -p "$BIN4"
code=$(run_install "$WORK/log4" FAKE_FIXTURES="$FIX" FAKE_NO_CHECKSUMS=1 FAKE_UNAME_S=Linux FAKE_UNAME_M=x86_64 \
  TOOLNET_INSTALL_DIR="$BIN4" HOME="$HOME1")
if [ "$code" = "0" ] && [ -x "$BIN4/toolnet" ] && grep -qi "checksum" "$WORK/log4"; then
  ok "install proceeded without checksums (warned)"
else
  bad "missing-checksums handling (exit=$code)"; sed -n '1,20p' "$WORK/log4"
fi

# ── 5. unsupported architecture is rejected ──────────────────────────────────
echo "== 5. unsupported arch is rejected =="
code=$(run_install "$WORK/log5" FAKE_FIXTURES="$FIX" FAKE_UNAME_S=Linux FAKE_UNAME_M=armv7l \
  TOOLNET_INSTALL_DIR="$WORK/arch/bin" HOME="$HOME1")
if [ "$code" != "0" ] && grep -q "32-bit ARM" "$WORK/log5"; then
  ok "armv7l rejected"
else
  bad "unsupported-arch handling (exit=$code)"; sed -n '1,20p' "$WORK/log5"
fi

# ── 6. darwin arm64 detection → correct artifact ─────────────────────────────
echo "== 6. darwin-arm64 detection selects the right artifact =="
FIX6="$WORK/fix6"; new_fixtures "$FIX6"; make_archive "toolnet-darwin-arm64" "$FIX6" "PAYLOAD-D"
HASH6="$(cat "$FIX6/.hash")"
printf '%s  toolnet-darwin-arm64.tar.gz\n' "$HASH6" > "$FIX6/checksums.txt"
BIN6="$WORK/darwin/bin"; mkdir -p "$BIN6"
code=$(run_install "$WORK/log6" FAKE_FIXTURES="$FIX6" FAKE_UNAME_S=Darwin FAKE_UNAME_M=arm64 \
  TOOLNET_INSTALL_DIR="$BIN6" HOME="$HOME1")
if [ "$code" = "0" ] && [ "$(cat "$BIN6/toolnet" 2>/dev/null)" = "PAYLOAD-D" ] && grep -q "darwin-arm64" "$WORK/log6"; then
  ok "darwin-arm64 installed from the correct artifact"
else
  bad "darwin-arm64 handling (exit=$code)"; sed -n '1,20p' "$WORK/log6"
fi

# ── 7. no destructive PATH / rc-file modification ────────────────────────────
echo "== 7. installer never writes shell rc files =="
touch_rc=0
for h in "$HOME1" "$HOMEFB"; do
  for rc in .bashrc .zshrc .profile .bash_profile; do
    [ -e "$h/$rc" ] && touch_rc=1
  done
done
if [ "$touch_rc" -eq 0 ]; then
  ok "no rc files created in HOME"
else
  bad "installer touched a shell rc file"; ls -la "$HOME1" "$HOMEFB"
fi

echo
echo "installer-smoke: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
