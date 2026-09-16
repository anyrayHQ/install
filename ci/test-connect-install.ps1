# Functional guard for the install step in connect.ps1.
#
# The shipped installer moves the verified download onto the stable path every
# hook, MCP registration, tray and scheduled task names. On a machine that
# already has Anyray, that path is often a RUNNING .exe, and Windows refuses to
# overwrite a loaded image. `Move-Item -Force` reported that refusal as "Cannot
# create a file when that file already exists" (ERROR_ALREADY_EXISTS), which
# reads as a stale-file problem and sends the user to delete a file -Force was
# already meant to replace; it is a PowerShell error-message bug
# (PowerShell/PowerShell#16990, #21251), and no switch makes the overwrite work.
# Re-enrollment hit it every time. A parse check cannot see any of that.
#
# Five cases, against the helper lifted out of the shipped file so this cannot
# drift from what customers run:
#   1. fresh install, nothing at the destination
#   2. overwrite an idle destination, leaving no aside behind
#   3. an aside a previous install could not delete is swept
#   4. the move fails after the aside: the live copy comes back
#   5. an unrenameable (= running) destination: retried, then an actionable
#      message that keeps the underlying cause, with the live copy untouched
#
# Case 5 shadows Rename-Item because a loaded-image lock is the one thing a
# Linux CI runner cannot produce. Everything either side of it is the real
# filesystem.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $ConnectPs1)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Lift the helper out of the shipped installer, so this cannot drift from it.
$src = Get-Content $ConnectPs1 -Raw
$match = [regex]::Match($src, '(?ms)^function Install-AnyrayBinary \{.*?\r?\n\}\r?\n')
if (-not $match.Success) { throw 'Install-AnyrayBinary not found in connect.ps1' }
Invoke-Expression $match.Value

# The shipped call site must be the one this covers: a second Move-Item onto
# the stable path would reintroduce the bug behind a passing test.
if ($src -notmatch '(?m)^\s*Install-AnyrayBinary -Source \$dl -Destination \$bin\s*$') {
  throw 'connect.ps1 no longer installs the download through Install-AnyrayBinary'
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("anyray-install-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $bin = Join-Path $work 'anyray-connect.exe'
  function New-Download {
    param([string] $Content)
    $path = Join-Path $work ("dl-" + [guid]::NewGuid().ToString('N'))
    Set-Content -LiteralPath $path -Value $Content -NoNewline
    return $path
  }
  function Assert-Installed {
    param([string] $Case, [string] $Content)
    $got = Get-Content -Raw -LiteralPath $bin
    if ($got -ne $Content) { throw "install case ${Case}: expected '$Content' at the stable path, found '$got'" }
  }
  # Re-wrapped at every call site: a function returning an empty array hands
  # back $null, and StrictMode then fails on .Count rather than reading 0.
  function Get-Asides { Get-ChildItem -LiteralPath $work -File | Where-Object { $_.Name -like 'anyray-connect.exe.old-*' } }

  # 1. fresh install
  $dl = New-Download 'v1'
  Install-AnyrayBinary -Source $dl -Destination $bin
  Assert-Installed '1 (fresh install)' 'v1'
  if (Test-Path -LiteralPath $dl) { throw 'install case 1: the download was left in the temp dir' }

  # 2. overwrite an idle destination
  Install-AnyrayBinary -Source (New-Download 'v2') -Destination $bin
  Assert-Installed '2 (overwrite)' 'v2'
  if (@(Get-Asides).Count -ne 0) { throw 'install case 2: an aside survived a clean overwrite' }

  # 3. an aside a previous install could not delete (its process was still
  # running then) is swept on the next one, instead of accumulating a copy of
  # the ~100 MB binary per re-enrollment.
  Set-Content -LiteralPath (Join-Path $work 'anyray-connect.exe.old-9999') -Value 'stale' -NoNewline
  Install-AnyrayBinary -Source (New-Download 'v3') -Destination $bin
  Assert-Installed '3 (stale aside)' 'v3'
  if (@(Get-Asides).Count -ne 0) { throw 'install case 3: the stale aside was not swept' }

  # 4. the move fails after the live copy moved aside: it must come back, or a
  # failed install leaves the machine with no binary at the path every hook names.
  $threw = $false
  try { Install-AnyrayBinary -Source (Join-Path $work 'no-such-download') -Destination $bin }
  catch { $threw = $true }
  if (-not $threw) { throw 'install case 4: reported success with no source file' }
  Assert-Installed '4 (rollback)' 'v3'
  if (@(Get-Asides).Count -ne 0) { throw 'install case 4: the aside was left behind after rollback' }

  # 5. a destination that cannot be renamed, i.e. a running .exe on Windows.
  $script:renameCalls = 0
  function Rename-Item {
    param([string] $LiteralPath, [string] $NewName, [switch] $Force, $ErrorAction)
    $script:renameCalls++
    throw [System.IO.IOException]::new('Cannot create a file when that file already exists.')
  }
  $keptDownload = New-Download 'v4'
  $started = Get-Date
  $message = $null
  try { Install-AnyrayBinary -Source $keptDownload -Destination $bin }
  catch { $message = $_.Exception.Message }
  if (-not $message) { throw 'install case 5: reported success against an unrenameable destination' }
  if ($message -notlike '*close Claude Code, Codex and the Anyray tray*') {
    throw "install case 5: the message does not say what to close: $message"
  }
  if ($message -notlike '*Cannot create a file when that file already exists.*') {
    throw "install case 5: the underlying cause was dropped: $message"
  }
  if ($script:renameCalls -ne 3) { throw "install case 5: expected 3 attempts, got $($script:renameCalls)" }
  # An on-access AV scan holds the file for a moment; a running process holds it
  # for good. The backoff is what separates them, so assert it actually elapsed.
  $elapsed = ((Get-Date) - $started).TotalMilliseconds
  if ($elapsed -lt 500) { throw ("install case 5: the retries did not back off ({0:N0}ms)" -f $elapsed) }
  Assert-Installed '5 (locked destination)' 'v3'
  if (-not (Test-Path -LiteralPath $keptDownload)) { throw 'install case 5: the download was consumed by a failed install' }

  Write-Host 'connect.ps1 install: 5/5 cases OK'
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
