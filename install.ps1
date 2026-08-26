<#
.SYNOPSIS
    Install ToolNet CLI on Windows (x64).

.DESCRIPTION
    Downloads the latest ToolNet CLI binary from GitHub Releases,
    verifies the SHA-256 checksum, and installs it to the user-local
    bin directory (no Administrator required).

    Usage:
      irm https://raw.githubusercontent.com/LBT-AI/Toolnet-CLI/main/install.ps1 | iex

    Environment variable overrides:
      $env:TOOLNET_VERSION         — specific version to install
      $env:TOOLNET_INSTALL_DIR     — custom install directory
#>

param()

$ErrorActionPreference = "Stop"

$REPO        = "LBT-AI/Toolnet-CLI"
$BINARY_NAME = "toolnet"
$ARCH        = "x64"

# ─── Helpers ───────────────────────────────────────────────────────
function Write-Info  { param($msg) Write-Host $msg -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "✔ $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "⚠ $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "✘ $msg" -ForegroundColor Red; exit 1 }

# ─── Resolve version ──────────────────────────────────────────────
function Resolve-Version {
    if ($env:TOOLNET_VERSION) { return $env:TOOLNET_VERSION }
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" -UseBasicParsing -TimeoutSec 10
        $tag = $release.tag_name -replace '^v', ''
        if ($tag) { return $tag }
    } catch {
        Write-Fail "Could not determine latest version. Set `$env:TOOLNET_VERSION manually."
    }
}

# ─── Main ──────────────────────────────────────────────────────────
$version = Resolve-Version
Write-Info "Installing ToolNet CLI v$version (windows-$ARCH)"

$artifactName = "$BINARY_NAME-windows-$ARCH"
$zipName      = "$artifactName.zip"
$downloadUrl  = "https://github.com/$REPO/releases/download/v$version/$zipName"
$checksumUrl  = "https://github.com/$REPO/releases/download/v$version/checksums.txt"

# Ensure $env:USERPROFILE\bin exists
$installDir = if ($env:TOOLNET_INSTALL_DIR) { $env:TOOLNET_INSTALL_DIR } else { Join-Path $env:USERPROFILE "bin" }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Add to PATH for this session if needed
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User") -split ";"
if ($installDir -notin $currentPath) {
    $env:Path = "$installDir;$env:Path"
    # Persist
    [Environment]::SetEnvironmentVariable("Path", "$installDir;$([Environment]::GetEnvironmentVariable('Path', 'User'))", "User")
    Write-Info "Added $installDir to user PATH."
}

# Download zip
$tmpDir = Join-Path $env:TEMP "toolnet-update-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$zipPath = Join-Path $tmpDir $zipName

Write-Info "Downloading $downloadUrl ..."
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 60
} catch {
    Write-Fail "Download failed: $($_.Exception.Message)"
}

# Verify checksum
try {
    $checksumText = Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing -TimeoutSec 10 | Select-Object -ExpandProperty Content
    $expectedLine = $checksumText -split "`n" | Where-Object { $_ -match $artifactName } | Select-Object -First 1
    if ($expectedLine) {
        $expectedHash = ($expectedLine -split '\s+')[0].Trim().ToLower()
        $actualHash   = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
        if ($expectedHash -ne $actualHash) {
            Write-Fail "SHA-256 mismatch!`n  Expected: $expectedHash`n  Got:      $actualHash"
        }
        Write-Ok "Checksum verified."
    } else {
        Write-Warn "No checksum entry for $zipName — skipping verification."
    }
} catch {
    Write-Warn "Could not verify checksum — skipping."
}

# Extract
Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

$binarySource = Join-Path $tmpDir "$BINARY_NAME.exe"
if (-not (Test-Path $binarySource)) {
    Write-Fail "Binary not found after extraction: $binarySource"
}

# Atomic install
$targetPath = Join-Path $installDir "$BINARY_NAME.exe"
$backupPath = "$targetPath.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
if (Test-Path $targetPath) {
    Rename-Item -Path $targetPath -Destination $backupPath -Force -ErrorAction SilentlyContinue
}
Copy-Item -Path $binarySource -Destination $targetPath -Force
Remove-Item -Path $backupPath -Force -ErrorAction SilentlyContinue

# Cleanup
Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Ok "ToolNet CLI v$version installed to $targetPath"
Write-Host ""
Write-Host "  Run:  toolnet --version"
Write-Host "        toolnet config init    # first-run setup"
Write-Host ""
Write-Host "Uninstall:" -ForegroundColor Gray
Write-Host "  Remove-Item '$targetPath'" -ForegroundColor Gray
