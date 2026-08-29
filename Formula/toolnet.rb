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
  version "1.1.0"
  license "MIT"

  on_macos do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-x64.tar.gz"
      sha256 "a971f62771e8b6574b17db5422214d7f31b9427efc7f9180e61eb3350a0bbd59"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-arm64.tar.gz"
      sha256 "5c4f32e3a091722d431347d443bad2d763aeb8274bdb9a20fb30e660e15ae27c"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-x64.tar.gz"
      sha256 "fa53f8b422e5e4aea62a3724af257b50a1cad5a460048b4f51fd7b03e3a919f5"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-arm64.tar.gz"
      sha256 "ddc93e8af016660efdf08bb3ce5cbbe2c8dc6337627af5c2b6e894bb742577cd"
    end
  end

  def install
    bin.install "toolnet"
  end

  test do
    system "#{bin}/toolnet", "--version"
  end
end
