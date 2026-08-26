# typed: false
# frozen_string_literal: true

# Homebrew formula for ToolNet CLI
# Install: brew install lbt-ai/tap/toolnet
#
# NOTE: SHA256 checksums are filled in by the release automation script
# (scripts/update-formula-checksums.sh). Do NOT edit them manually.
# The placeholder values below will cause an install failure — that is
# intentional to prevent publishing a formula without real checksums.

class Toolnet < Formula
  desc "AI coding agent for the terminal"
  homepage "https://github.com/LBT-AI/Toolnet-CLI"
  version "1.0.5"
  license "MIT"

  on_macos do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_X64"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_ARM64"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-x64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_X64"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_ARM64"
    end
  end

  def install
    bin.install "toolnet"
  end

  test do
    system "#{bin}/toolnet", "--version"
  end
end
