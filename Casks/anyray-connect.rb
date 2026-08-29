cask "anyray-connect" do
  version "0.11.174"
  sha256 "4a41cc5efddea4883da0c476dea35deae6907a298d434a08f315bfb429c7c104"

  url "https://github.com/anyrayHQ/install/releases/download/connect-v#{version}/anyray-connect.pkg"
  name "Anyray Connect"
  desc "On-ramp CLI that routes AI coding assistants through the Anyray gateway"
  homepage "https://anyray.ai/"

  # Releases are tagged `connect-v<version>` (staging builds ship as
  # pre-releases), so track the latest stable release and pull the version out
  # of its tag. This lets `brew bump-cask-pr` notice new versions.
  livecheck do
    url :url
    strategy :github_latest
    regex(/connect-v(\d+(?:\.\d+)+)/i)
  end

  # anyray-connect keeps itself current through its own signed self-update path
  # (selfUpdate.ts fetches the next release), so Homebrew only bootstraps the
  # trusted, signed + notarized install and must not fight the app's updater.
  auto_updates true
  depends_on macos: :ventura

  pkg "anyray-connect.pkg"

  # The universal payload lays down /usr/local/bin/anyray-connect, the
  # managed-enroll helper under /usr/local/lib/anyray-connect, and the
  # ai.anyray.connect.managed-enroll LaunchAgent. Unload the agent, forget the
  # receipt (which removes the payload files), then sweep the parent dir.
  uninstall launchctl: "ai.anyray.connect.managed-enroll",
            pkgutil:   "ai.anyray.connect",
            delete:    "/usr/local/lib/anyray-connect"

  # The managed-enroll LaunchAgent runner writes per-user diagnostics here
  # (never prompt/response content). The receipt does not track them, so zap
  # sweeps them on --zap. The MDM-managed preference under
  # /Library/Managed Preferences is deliberately left alone: MDM owns it.
  zap trash: "~/Library/Logs/Anyray Connect"
end
