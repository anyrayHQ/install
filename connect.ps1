<#
  Anyray zero-install developer connect (Windows / PowerShell).

  Recommended (passes the setup link as an argument):
    & ([scriptblock]::Create((irm https://app.anyray.ai/connect.ps1))) "<setup-link-or-gateway-url>" [flags]

  Managed enrollment:
    & ([scriptblock]::Create((irm https://app.anyray.ai/connect.ps1))) "--managed"

  Or with an env var (handy for `irm ... | iex`):
    $env:ANYRAY_CONNECT = "<setup-link-or-gateway-url>"
    irm https://app.anyray.ai/connect.ps1 | iex

  Downloads the standalone `anyray-connect.exe` (no Node, nothing to install)
  from the public install repo's latest release, verifies its checksum, and runs
  it — pointing Claude Code / Codex at the Anyray gateway. Flags after the URL
  pass straight through (e.g. --subscription, --user, --dry-run).
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo  = 'anyrayHQ/install'
# Which release to install from. Unset — every customer — is `latest`, exactly
# as before. $env:ANYRAY_CONNECT_TAG pins a specific release so a staging build
# (published --latest=false, so `latest` can never reach it) is testable through
# the same command a developer actually runs. See connect.sh for the full
# rationale; the two must stay in step.
#
# Selects a release, never relaxes verification: $repo is fixed, so the download
# cannot be pointed at another host, and the checksum block below is unchanged.
# The value is regex-anchored because it lands in a URL path — an unvalidated
# tag containing `../` would walk out of /releases/download.
$tag = $env:ANYRAY_CONNECT_TAG
if ($tag) {
  if ($tag -notmatch '^connect(-staging)?-v[0-9]+\.[0-9]+\.[0-9]+$') {
    Write-Error "invalid ANYRAY_CONNECT_TAG '$tag' - expected connect-v<x.y.z> or connect-staging-v<x.y.z>"
  }
  $base = "https://github.com/$repo/releases/download/$tag"
  Write-Host "anyray-connect: pinned to release $tag (not latest)"
} else {
  $base = "https://github.com/$repo/releases/latest/download"
}
$asset = 'anyray-connect-windows-x64.exe'  # Bun compiles a single x64 Windows target

# Args: prefer real script args; fall back to $env:ANYRAY_CONNECT for the `| iex` form.
$connectArgs = @($args)
$managedInstall = $false
if ($connectArgs.Count -gt 0 -and $connectArgs[0] -eq '--managed') {
  $managedInstall = $true
  $connectArgs = if ($connectArgs.Count -gt 1) { @($connectArgs[1..($connectArgs.Count - 1)]) } else { @() }
}
if ($connectArgs.Count -eq 0 -and $env:ANYRAY_CONNECT) {
  $connectArgs = $env:ANYRAY_CONNECT -split '\s+' | Where-Object { $_ -ne '' }
}

$tmp = Join-Path $env:TEMP ("anyray-connect-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$dl = Join-Path $tmp 'anyray-connect.exe'

try {
  Write-Host "anyray-connect: downloading $asset..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $dl -UseBasicParsing

  # Verify the checksum from the same release. Every step here fails CLOSED, with
  # no bypass flag or env var: the exe below installs a Claude Code PostToolUse
  # hook that then runs on every tool call, so an unverified download is a
  # persistent code-execution foothold, not a one-off. Skipping verification when
  # something is merely *missing* hands that foothold to anyone who can make one
  # request fail. The SHA256SUMS download stays in a catch-all only because the
  # error type differs by host (pwsh's HttpResponseException vs Windows
  # PowerShell's WebException); it now RETHROWS instead of continuing. A genuine
  # checksum MISMATCH is still thrown OUTSIDE any catch.
  $sumsPath = Join-Path $tmp 'SHA256SUMS'
  try {
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
  } catch {
    throw "could not fetch the checksums ($base/SHA256SUMS) - refusing to run an unverified $asset; retry, or use: npx anyray-connect <url>"
  }
  $want = (Get-Content $sumsPath | ForEach-Object {
    $p = $_ -split '\s+'
    if ($p.Length -ge 2 -and ($p[1].TrimStart('*') -eq $asset)) { $p[0] }
  } | Select-Object -First 1)
  if (-not $want) { throw "no SHA256SUMS entry for $asset - refusing to run an unverified binary; use: npx anyray-connect <url>" }
  # Get-FileHash ships with PowerShell 5.1, so there is no "no hash tool" path to
  # fall through: an unusable hash is an error, never a skipped check.
  $got = (Get-FileHash -Algorithm SHA256 -Path $dl).Hash
  if (-not $got) { throw "could not compute the SHA-256 of $asset - refusing to run an unverified binary; use: npx anyray-connect <url>" }
  if ($got.ToLower() -ne $want.ToLower()) { throw "checksum mismatch for $asset - refusing to run" }

  # Install to a PERSISTENT location, then run from there. anyray-connect installs
  # a Claude Code PostToolUse hook that references this exe by absolute path on
  # every tool call, so it must survive after $tmp is cleaned in `finally`.
  $installDir = if ($env:ANYRAY_HOME) { Join-Path $env:ANYRAY_HOME 'bin' } else { Join-Path $env:USERPROFILE '.anyray\bin' }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $bin = Join-Path $installDir 'anyray-connect.exe'
  Move-Item -Force -Path $dl -Destination $bin

  if ($managedInstall) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
      throw '--managed must run in a signed-in user context'
    }
    $taskName = "Anyray Connect Managed Enrollment $($identity.User.Value)"
    $action = New-ScheduledTaskAction -Execute $bin -Argument '__anyray-managed-enroll'
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    & $bin '__anyray-managed-enroll'
    if ($LASTEXITCODE -ne 0 -or $connectArgs.Count -eq 0) { exit $LASTEXITCODE }
  }

  & $bin @connectArgs
  exit $LASTEXITCODE
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
