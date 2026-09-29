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
  version "1.4.0"
  license "MIT"

  on_macos do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-x64.tar.gz"
      sha256 "439b28f9fa555fb438b4f9201f76b6c80950b334e69626bdcdc37932afee0793"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-arm64.tar.gz"
      sha256 "032d8c3f304c4c10a46426982c5fa8c6e5f26663e78b25d6c77ab50bb0beaafc"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-x64.tar.gz"
      sha256 "53b83fbd0d8a03cc1e659b02ac632bcc4f1deb99743c75380fbcde3382c6c391"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-arm64.tar.gz"
      sha256 "ebc1ff20d086274407b4828969be83da1e862728e1a60dc749a2da6bf40377f2"
    end
  end

  def install
    bin.install "toolnet"
  end

  test do
    system "#{bin}/toolnet", "--version"
  end
end
