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
  version "1.2.3"
  license "MIT"

  on_macos do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-x64.tar.gz"
      sha256 "ecb9aa33f171460560946971f0a2b6c02a916978b3b5aad907b410c55f2ae044"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-arm64.tar.gz"
      sha256 "8c7ce07db81f26555ef55e071e1fbeccc45766ec07f5665e8bd94adc7661c812"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-x64.tar.gz"
      sha256 "c85a94635b03d638bc70696d304e0a9bb988bd2256d7ac315fcb2b17887065bb"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-arm64.tar.gz"
      sha256 "f2302eaa32eff35495022a051bbc18b1c9e590c7bd55b6681e521d5bae824523"
    end
  end

  def install
    bin.install "toolnet"
  end

  test do
    system "#{bin}/toolnet", "--version"
  end
end
