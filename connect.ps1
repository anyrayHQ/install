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
  from the latest release, verifies its checksum, and runs it — pointing
  Claude Code / Codex at the Anyray gateway. Flags after the URL pass straight
  through (e.g. --subscription, --user, --dry-run).
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo  = 'anyrayHQ/install'
# Where releases come from, in order. Anyray's mirror first, so a network that
# blocks GitHub can still install; it serves every GitHub release byte for byte
# under the same <tag>/<asset> key. GitHub is tried only when the mirror does
# not answer. Both are fixed here: nothing in the environment can point the
# download at another host. See connect.sh; the two must stay in step.
$mirror = 'https://app.anyray.ai/connect/dl'
$githubDownload = "https://github.com/$repo/releases/download"

# The current release, from the mirror's pointer (latest.json). Returns its tag,
# or '' when the mirror does not answer, which means GitHub's `latest`. A
# pointer the mirror DOES serve must name a release, or this throws: the mirror
# answering with nonsense is not a reason to go elsewhere. The short timeout
# keeps a blackholed host from stalling the install.
function Get-AnyrayPointerTag {
  param([Parameter(Mandatory = $true)][string] $Mirror)
  try {
    $request = [System.Net.WebRequest]::Create("$Mirror/latest.json")
    $request.UserAgent = 'anyray-connect-installer'
    $request.Timeout = 10000
    $request.ReadWriteTimeout = 20000
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Close() }
  } catch {
    return ''
  }
  # Anchored by both quotes, so `connect-v1.2.3/../x` cannot match.
  $found = [regex]::Match($body, '"tag"\s*:\s*"(connect-v[0-9]+\.[0-9]+\.[0-9]+)"')
  if (-not $found.Success) {
    throw "the release pointer $Mirror/latest.json names no release - retry, or use: npx anyray-connect <url>"
  }
  return $found.Groups[1].Value
}

# Which release to install from. Unset — every customer — is the current
# release: the one the mirror's pointer names, or GitHub's `latest` when the
# mirror does not answer. $env:ANYRAY_CONNECT_TAG pins a specific release so a
# staging build (published --latest=false, so `latest` can never reach it) is
# testable through the same command a developer actually runs. See connect.sh
# for the full rationale; the two must stay in step.
#
# Selects a release, never relaxes verification: the hosts are fixed, so the
# download cannot be pointed elsewhere, and the checksum block below is
# unchanged. The value is regex-anchored because it lands in a URL path — an
# unvalidated tag containing `../` would walk out of /releases/download.
$tag = $env:ANYRAY_CONNECT_TAG
if ($tag) {
  if ($tag -notmatch '^connect(-staging)?-v[0-9]+\.[0-9]+\.[0-9]+$') {
    Write-Error "invalid ANYRAY_CONNECT_TAG '$tag' - expected connect-v<x.y.z> or connect-staging-v<x.y.z>"
  }
  Write-Host "anyray-connect: pinned to release $tag (not latest)"
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

# Download with resume. The Windows asset is ~100 MB and `Invoke-WebRequest` is
# one shot: a proxy, a VPN or a flaky link that drops the connection mid-transfer
# ends enrollment with "The request was aborted: The connection was closed
# unexpectedly" and keeps none of what already arrived, so a retry pays for the
# whole file again and can lose the same way. Both release hosts answer
# `accept-ranges: bytes`, so each attempt below resumes from the bytes on disk.
# Resuming is safe only because the SHA-256 check further down is unconditional:
# a spliced or truncated file fails closed there, exactly like a corrupt
# single-shot download. Streaming also skips 5.1's per-read progress bar, which
# alone costs a large download an order of magnitude in time.
function Get-AnyrayDownload {
  param(
    [Parameter(Mandatory = $true)][string] $Uri,
    [Parameter(Mandatory = $true)][string] $OutFile,
    [int] $Attempts = 4,
    [int] $TimeoutMs = 60000
  )
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $have = if (Test-Path -LiteralPath $OutFile) { (Get-Item -LiteralPath $OutFile).Length } else { 0 }
    try {
      $request = [System.Net.WebRequest]::Create($Uri)
      $request.UserAgent = 'anyray-connect-installer'
      $request.Timeout = $TimeoutMs
      $request.ReadWriteTimeout = 300000
      if ($have -gt 0) { $request.AddRange($have) }
      try {
        $response = $request.GetResponse()
      } catch [System.Net.WebException] {
        # 416: the range starts past the end, i.e. the file on disk is already
        # the whole asset (the previous attempt died on the very last bytes).
        # Retrying forever would fail an otherwise-complete download; the
        # checksum below still decides whether these bytes are the real thing.
        $status = $null
        if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode }
        if ($have -gt 0 -and $status -eq [System.Net.HttpStatusCode]::RequestedRangeNotSatisfiable) { return }
        throw
      }
      try {
        # A host that ignores Range answers 200 with the WHOLE body; appending
        # that to a partial file would splice two copies together, so restart.
        if ($have -gt 0 -and $response.StatusCode -ne [System.Net.HttpStatusCode]::PartialContent) { $have = 0 }
        $mode = if ($have -gt 0) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
        $file = New-Object System.IO.FileStream($OutFile, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $response.GetResponseStream().CopyTo($file) } finally { $file.Dispose() }
      } finally { $response.Close() }
      return
    } catch {
      $lastError = $_
      if ($attempt -ge $Attempts) { break }
      $landed = if (Test-Path -LiteralPath $OutFile) { (Get-Item -LiteralPath $OutFile).Length } else { 0 }
      Write-Host ("anyray-connect: transfer interrupted at {0:N0} MB, resuming (attempt {1} of {2})..." -f ($landed / 1MB), ($attempt + 1), $Attempts) -ForegroundColor Yellow
      Start-Sleep -Seconds ([Math]::Min(8, [Math]::Pow(2, $attempt - 1)))
    }
  }
  throw $lastError
}

# The bases to try for a tag, in order: the mirror, then GitHub. No tag (the
# mirror did not answer) leaves GitHub's `latest` alone.
function Get-AnyrayBases {
  param(
    [string] $Tag,
    [Parameter(Mandatory = $true)][string] $Mirror,
    [Parameter(Mandatory = $true)][string] $GithubDownload,
    [Parameter(Mandatory = $true)][string] $Repo
  )
  if ($Tag) { return @("$Mirror/$Tag", "$GithubDownload/$Tag") }
  Write-Host "anyray-connect: $Mirror did not answer; using github.com" -ForegroundColor Yellow
  return @("https://github.com/$Repo/releases/latest/download")
}

# One host at a time: its SHA256SUMS, then the asset, both from that base, so
# the checksum below always describes bytes from the host that published them
# (the hosts can briefly disagree about a release). A host that does not answer
# (a network error or an HTTP error) hands over to the next. Nothing here looks
# at a checksum, so a mismatch can never send the download elsewhere. Returns
# the base both files came from.
function Get-AnyrayRelease {
  param(
    [Parameter(Mandatory = $true)][string[]] $Bases,
    [Parameter(Mandatory = $true)][string] $Mirror,
    [Parameter(Mandatory = $true)][string] $Asset,
    [Parameter(Mandatory = $true)][string] $OutFile,
    [Parameter(Mandatory = $true)][string] $SumsFile
  )
  foreach ($candidate in $Bases) {
    Remove-Item -LiteralPath $OutFile, $SumsFile -Force -ErrorAction SilentlyContinue
    try {
      if ($candidate.StartsWith("$Mirror/", [System.StringComparison]::Ordinal)) {
        Get-AnyrayDownload -Uri "$candidate/SHA256SUMS" -OutFile $SumsFile -Attempts 2 -TimeoutMs 5000
      } else {
        Get-AnyrayDownload -Uri "$candidate/SHA256SUMS" -OutFile $SumsFile -Attempts 3
      }
      Write-Host "anyray-connect: downloading $Asset..." -ForegroundColor Cyan
      Get-AnyrayDownload -Uri "$candidate/$Asset" -OutFile $OutFile
      return $candidate
    } catch {
      Write-Host "anyray-connect: could not download from $candidate" -ForegroundColor Yellow
    }
  }
  throw "download failed from every release host - check your connection or use: npx anyray-connect <url>"
}

# Put the downloaded exe at the stable path, even when the copy already there is
# RUNNING. Windows refuses to overwrite a loaded image, and `Move-Item -Force`
# reports that refusal as "Cannot create a file when that file already exists"
# (ERROR_ALREADY_EXISTS), which reads as "the destination exists" and sends the
# user to delete a file that -Force was already meant to replace. It is a
# PowerShell error-message bug (PowerShell/PowerShell#16990, #21251), not a
# missing flag: no switch makes the overwrite succeed. Re-enrollment on a
# machine that already has Anyray hits this every time, because the Claude Code
# PostToolUse hook, the MCP server, the tray and the managed-enrollment task all
# execute this exact path.
#
# Renaming a running image aside IS allowed, so do what the self-updater's
# `activate()` does: move the live copy out of the way, put the new one in
# place, then try to delete the old one (that delete fails while the old process
# lives, which is why the aside is swept by the next run rather than here).
#
# The new bytes are staged INTO the install dir first, so the two steps that
# leave the stable path empty are both same-directory renames. $env:TEMP is not
# always on the volume the profile is on (a redirected TEMP, a RAM disk), and a
# cross-volume `Move-Item` copies ~100 MB: doing that between the aside and the
# restore would leave every hook, the MCP server and the scheduled task with no
# binary at the path they name for as long as the copy runs. Staging first also
# means a failed or interrupted download never touches the live copy at all.
function Install-AnyrayBinary {
  param(
    [Parameter(Mandatory = $true)][string] $Source,
    [Parameter(Mandatory = $true)][string] $Destination
  )
  $dir = Split-Path -Parent $Destination
  $leaf = Split-Path -Leaf $Destination

  # Sweep what earlier installs could not delete: an aside whose process was
  # still running, or staging bytes from an interrupted run. Matched on Name,
  # not -Filter: the filesystem wildcard -Filter uses also matches 8.3 short
  # names, which would sweep files this never created.
  Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$leaf.old-*" -or $_.Name -like "$leaf.new-*" } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

  # Unique per ATTEMPT, not per process. $PID alone collides with itself: the
  # `irm | iex` form is usually re-run in the same PowerShell window, so a
  # second enrollment computes the same aside name, and if the first one is
  # still held by a running binary the sweep above cannot clear it. The rename
  # would then fail on the occupied name and report a replaceable binary as
  # locked.
  $stamp = "$PID-" + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $staging = Join-Path $dir "$leaf.new-$stamp"
  $aside = Join-Path $dir "$leaf.old-$stamp"

  Move-Item -LiteralPath $Source -Destination $staging -Force

  $movedAside = $false
  try {
    if (Test-Path -LiteralPath $Destination) {
      # An on-access AV scan can hold the file for a moment; a running Anyray
      # process holds it for good, so the backoff is what separates the two.
      for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
          Rename-Item -LiteralPath $Destination -NewName "$leaf.old-$stamp" -Force
          $movedAside = $true
          break
        } catch {
          if ($attempt -eq 3) {
            throw "could not replace $Destination - close Claude Code, Codex and the Anyray tray, then re-run this command ($($_.Exception.Message))"
          }
          Start-Sleep -Milliseconds (200 * $attempt)
        }
      }
    }
    Move-Item -LiteralPath $staging -Destination $Destination -Force
  } catch {
    if ($movedAside) { Rename-Item -LiteralPath $aside -NewName $leaf -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
    throw
  }
  # Fails while the old binary is still running. Harmless: the sweep above
  # clears it on the next install, and nothing references the aside path.
  if ($movedAside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
}

$tmp = Join-Path $env:TEMP ("anyray-connect-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$dl = Join-Path $tmp 'anyray-connect.exe'

try {
  if (-not $tag) { $tag = Get-AnyrayPointerTag -Mirror $mirror }
  $bases = Get-AnyrayBases -Tag $tag -Mirror $mirror -GithubDownload $githubDownload -Repo $repo
  $sumsPath = Join-Path $tmp 'SHA256SUMS'
  $base = Get-AnyrayRelease -Bases $bases -Mirror $mirror -Asset $asset -OutFile $dl -SumsFile $sumsPath

  # Verify the checksum from the same release and host. Every step here fails
  # CLOSED, with no bypass flag or env var: the exe below installs a Claude Code
  # PostToolUse hook that then runs on every tool call, so an unverified download
  # is a persistent code-execution foothold, not a one-off. Skipping verification
  # when something is merely *missing* hands that foothold to anyone who can make
  # one request fail: a host whose SHA256SUMS cannot be fetched is a host that did
  # not answer, and no host answering is an error above. A genuine checksum
  # MISMATCH is thrown OUTSIDE any catch and never tries the other host.
  $want = (Get-Content $sumsPath | ForEach-Object {
    $p = $_ -split '\s+'
    if ($p.Length -ge 2 -and ($p[1].TrimStart('*') -eq $asset)) { $p[0] }
  } | Select-Object -First 1)
  if (-not $want) { throw "no SHA256SUMS entry for $asset - refusing to run an unverified binary; use: npx anyray-connect <url>" }
  # Get-FileHash ships with PowerShell 5.1, so there is no "no hash tool" path to
  # fall through: an unusable hash is an error, never a skipped check.
  $got = (Get-FileHash -Algorithm SHA256 -Path $dl).Hash
  if (-not $got) { throw "could not compute the SHA-256 of $asset - refusing to run an unverified binary; use: npx anyray-connect <url>" }
  if ($got.ToLower() -ne $want.ToLower()) { throw "checksum mismatch for $asset from $base - refusing to run" }

  # Install to a PERSISTENT location, then run from there. anyray-connect installs
  # a Claude Code PostToolUse hook that references this exe by absolute path on
  # every tool call, so it must survive after $tmp is cleaned in `finally`.
  $installDir = if ($env:ANYRAY_HOME) { Join-Path $env:ANYRAY_HOME 'bin' } else { Join-Path $env:USERPROFILE '.anyray\bin' }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  $bin = Join-Path $installDir 'anyray-connect.exe'
  Install-AnyrayBinary -Source $dl -Destination $bin

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
