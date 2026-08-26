#!/usr/bin/env bash
# ToolNet CLI — official install script
# Usage: curl -fsSL https://raw.githubusercontent.com/LBT-AI/Toolnet-CLI/main/install.sh | sh
# Env overrides:
#   TOOLNET_VERSION=x.y.z       — install a specific version
#   TOOLNET_INSTALL_DIR=/path   — custom install directory

set -euo pipefail

REPO="LBT-AI/Toolnet-CLI"
BINARY_NAME="toolnet"

# ---- Helpers ----
info()  { printf "\033[36m%s\033[0m\n" "$*"; }
ok()    { printf "\033[32m✔ %s\033[0m\n" "$*"; }
warn()  { printf "\033[33m⚠ %s\033[0m\n" "$*" >&2; }
fail()  { printf "\033[31m✘ %s\033[0m\n" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not found in PATH."
}

# ---- Detect OS ----
detect_os() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo "windows" ;;
    *)       fail "Unsupported OS: $os" ;;
  esac
}

# ---- Detect Arch ----
detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)       echo "x64" ;;
    aarch64|arm64)      echo "arm64" ;;
    armv7l|armhf|arm)   fail "32-bit ARM is not supported. Use a 64-bit system." ;;
    i386|i686)          fail "32-bit x86 is not supported." ;;
    *)                  fail "Unsupported architecture: $arch" ;;
  esac
}

# ---- Resolve version ----
resolve_version() {
  if [ -n "${TOOLNET_VERSION:-}" ]; then
    echo "$TOOLNET_VERSION"
    return
  fi
  require_cmd curl
  local version
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"v([^"]+)".*/\1/')"
  if [ -z "$version" ]; then
    fail "Could not determine latest version. Set TOOLNET_VERSION manually."
  fi
  echo "$version"
}

# ---- Main ----
main() {
  require_cmd curl

  local os arch version
  os="$(detect_os)"
  arch="$(detect_arch)"
  version="$(resolve_version)"

  info "Installing ToolNet CLI v${version} (${os}-${arch})"

  # Map to artifact name
  local artifact_name="toolnet-${os}-${arch}"
  local ext=""
  local archive_ext=".tar.gz"
  if [ "$os" = "windows" ]; then
    ext=".exe"
    archive_ext=".zip"
  fi

  local download_url="https://github.com/${REPO}/releases/download/v${version}/${artifact_name}${archive_ext}"
  local checksum_url="https://github.com/${REPO}/releases/download/v${version}/checksums.txt"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  local archive_path="${tmpdir}/${artifact_name}${archive_ext}"
  info "Downloading ..."
  curl -fSL -o "$archive_path" "$download_url" || fail "Download failed: $download_url"

  # Verify SHA256
  local checksum_file="${tmpdir}/checksums.txt"
  if curl -fSL -o "$checksum_file" "$checksum_url" 2>/dev/null; then
    local expected_hash
    expected_hash="$(grep "$artifact_name" "$checksum_file" | head -1 | awk '{print $1}')"
    if [ -n "$expected_hash" ]; then
      local actual_hash
      if command -v sha256sum >/dev/null 2>&1; then
        actual_hash="$(sha256sum "$archive_path" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        actual_hash="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
      else
        warn "No sha256sum/shasum found — skipping checksum verification."
        expected_hash=""
      fi
      if [ -n "$expected_hash" ] && [ "$actual_hash" != "$expected_hash" ]; then
        fail "SHA-256 mismatch!\n  Expected: $expected_hash\n  Got:      $actual_hash"
      fi
      ok "Checksum verified."
    fi
  else
    warn "Could not download checksums — skipping verification."
  fi

  # Extract
  local binary_path="${tmpdir}/${artifact_name}${ext}"
  if [ "$archive_ext" = ".zip" ]; then
    require_cmd unzip
    unzip -o -q "$archive_path" -d "$tmpdir"
  else
    tar -xzf "$archive_path" -C "$tmpdir"
  fi

  [ -f "$binary_path" ] || fail "Binary not found after extraction: $binary_path"
  chmod +x "$binary_path"

  # Install
  local install_dir="${TOOLNET_INSTALL_DIR:-/usr/local/bin}"
  if [ ! -w "$install_dir" ]; then
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    info "Installing to $install_dir (no write access to /usr/local/bin)"

    # Add to PATH for this session
    case ":$PATH:" in
      *":$install_dir:"*) ;;
      *) export PATH="$install_dir:$PATH" ;;
    esac

    local shell_rc=""
    if [ -f "$HOME/.bashrc" ]; then shell_rc="$HOME/.bashrc"
    elif [ -f "$HOME/.zshrc" ]; then shell_rc="$HOME/.zshrc"
    fi
    if [ -n "$shell_rc" ] && ! grep -q "$install_dir" "$shell_rc" 2>/dev/null; then
      info "Adding $install_dir to PATH in $shell_rc"
      echo "" >> "$shell_rc"
      echo "# ToolNet CLI" >> "$shell_rc"
      echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$shell_rc"
    fi
  fi

  local target_path="${install_dir}/${BINARY_NAME}${ext}"
  # Atomic copy
  cp "$binary_path" "${target_path}.tmp"
  mv "${target_path}.tmp" "$target_path"
  chmod +x "$target_path"

  ok "ToolNet CLI v${version} installed to ${target_path}"
  echo ""
  echo "  Run:  toolnet --version"
  echo "        toolnet config init    # first-run setup"
  echo "        toolnet completion bash --install   # shell completions"
  echo ""
  echo "Uninstall:"
  echo "  rm ${target_path}"
  echo "  (and remove TOOLNET lines from your shell rc file if applicable)"
}

main "$@"
