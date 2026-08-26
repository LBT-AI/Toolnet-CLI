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
      sha256 "679b2d2fb53266d4b65bad5e9e28063d1394ee985a0a555a02fb8e1572a6c32f"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-darwin-arm64.tar.gz"
      sha256 "5b2023111547be892102f1537e7a2cc1fd39199b9997962c1bda3107ba792e16"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-x64.tar.gz"
      sha256 "5fd750257b0871a03c558e8ee2f78f6103382394fc97f34cf76339e5a17bf0bc"
    end
    on_arm do
      url "https://github.com/LBT-AI/Toolnet-CLI/releases/download/v#{version}/toolnet-linux-arm64.tar.gz"
      sha256 "fb6cfb2df774d6cf1968dc3620eee0602d91d356465ee03cb24e20b9deb05904"
    end
  end

  def install
    bin.install "toolnet"
  end

  test do
    system "#{bin}/toolnet", "--version"
  end
end
