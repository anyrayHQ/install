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
# Eight cases, against the helper lifted out of the shipped file so this cannot
# drift from what customers run:
#   1. fresh install, nothing at the destination
#   2. overwrite an idle destination, leaving nothing behind
#   3. an aside a previous install could not delete is swept
#   4. a bad download fails before the live copy is touched
#   5. the install fails after the aside: the live copy comes back
#   6. an unrenameable (= running) destination: retried, then an actionable
#      message that keeps the underlying cause, with the live copy untouched
#   7. a rename that fails once and then succeeds (the AV-scan shape) installs
#   8. two installs from one PowerShell session, the first aside still held
#
# WHAT THIS CANNOT COVER: a real Windows loaded-image lock. Every runner in this
# repo is Linux, where renaming and unlinking a running binary is simply
# allowed, so cases 6-8 drive the rename through a shadowed `Rename-Item`. That
# proves the helper's retry, rollback, naming and messaging, NOT that Windows
# permits the rename it is built on. The real thing belongs on the Windows EC2
# drill harness, not in a per-PR gate.
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
  function Get-Residue { Get-ChildItem -LiteralPath $work -File | Where-Object { $_.Name -like 'anyray-connect.exe.*' } }
  function Assert-NoResidue {
    param([string] $Case)
    $left = @(Get-Residue)
    if ($left.Count -ne 0) { throw "install case ${Case}: left $($left.Count) file(s) beside the binary: $($left.Name -join ', ')" }
  }

  # 1. fresh install
  $dl = New-Download 'v1'
  Install-AnyrayBinary -Source $dl -Destination $bin
  Assert-Installed '1 (fresh install)' 'v1'
  if (Test-Path -LiteralPath $dl) { throw 'install case 1: the download was left in the temp dir' }
  Assert-NoResidue '1 (fresh install)'

  # 2. overwrite an idle destination
  Install-AnyrayBinary -Source (New-Download 'v2') -Destination $bin
  Assert-Installed '2 (overwrite)' 'v2'
  Assert-NoResidue '2 (overwrite)'

  # 3. an aside a previous install could not delete (its process was still
  # running then) is swept on the next one, instead of accumulating a copy of
  # the ~100 MB binary per re-enrollment. Same for interrupted staging bytes.
  Set-Content -LiteralPath (Join-Path $work 'anyray-connect.exe.old-9999-deadbeef') -Value 'stale' -NoNewline
  Set-Content -LiteralPath (Join-Path $work 'anyray-connect.exe.new-9999-deadbeef') -Value 'partial' -NoNewline
  Install-AnyrayBinary -Source (New-Download 'v3') -Destination $bin
  Assert-Installed '3 (stale residue)' 'v3'
  Assert-NoResidue '3 (stale residue)'

  # 4. a source that isn't there fails before the live copy is touched at all —
  # staging happens first precisely so a bad download cannot cost the machine
  # the binary every hook names.
  $threw = $false
  try { Install-AnyrayBinary -Source (Join-Path $work 'no-such-download') -Destination $bin }
  catch { $threw = $true }
  if (-not $threw) { throw 'install case 4: reported success with no source file' }
  Assert-Installed '4 (bad download)' 'v3'
  Assert-NoResidue '4 (bad download)'

  # 5. the install fails AFTER the live copy moved aside: it must come back, or
  # a failed install leaves the machine with no binary at the stable path.
  $script:moveCalls = 0
  function Move-Item {
    param([string] $LiteralPath, [string] $Destination, [switch] $Force, $ErrorAction)
    $script:moveCalls++
    # Let the staging move through; fail the one that lands on the stable path.
    if ($script:moveCalls -ge 2) { throw [System.IO.IOException]::new('staged bytes vanished') }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
  }
  $threw = $false
  try { Install-AnyrayBinary -Source (New-Download 'v4') -Destination $bin }
  catch { $threw = $true }
  Remove-Item function:Move-Item
  if (-not $threw) { throw 'install case 5: reported success when the staged move failed' }
  Assert-Installed '5 (rollback)' 'v3'
  Assert-NoResidue '5 (rollback)'

  # 6. a destination that cannot be renamed, i.e. a running .exe on Windows.
  $script:renameCalls = 0
  function Rename-Item {
    param([string] $LiteralPath, [string] $NewName, [switch] $Force, $ErrorAction)
    $script:renameCalls++
    throw [System.IO.IOException]::new('Cannot create a file when that file already exists.')
  }
  $keptDownload = New-Download 'v5'
  $started = Get-Date
  $message = $null
  try { Install-AnyrayBinary -Source $keptDownload -Destination $bin }
  catch { $message = $_.Exception.Message }
  Remove-Item function:Rename-Item
  if (-not $message) { throw 'install case 6: reported success against an unrenameable destination' }
  if ($message -notlike '*close Claude Code, Codex and the Anyray tray*') {
    throw "install case 6: the message does not say what to close: $message"
  }
  if ($message -notlike '*Cannot create a file when that file already exists.*') {
    throw "install case 6: the underlying cause was dropped: $message"
  }
  if ($script:renameCalls -ne 3) { throw "install case 6: expected 3 attempts, got $($script:renameCalls)" }
  # The backoff is what separates a momentary AV hold from a real lock, so
  # assert it actually elapsed rather than trusting the loop's shape.
  $elapsed = ((Get-Date) - $started).TotalMilliseconds
  if ($elapsed -lt 500) { throw ("install case 6: the retries did not back off ({0:N0}ms)" -f $elapsed) }
  Assert-Installed '6 (locked destination)' 'v3'
  Assert-NoResidue '6 (locked destination)'

  # 7. the AV-scan shape: the rename fails once, then succeeds. The retry has to
  # RECOVER, not just give up politely — case 6 alone passes on a helper that
  # never installs anything.
  $script:renameCalls = 0
  function Rename-Item {
    param([string] $LiteralPath, [string] $NewName, [switch] $Force, $ErrorAction)
    $script:renameCalls++
    if ($script:renameCalls -eq 1) { throw [System.IO.IOException]::new('being used by another process') }
    Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName -Force:$Force
  }
  Install-AnyrayBinary -Source (New-Download 'v6') -Destination $bin
  Remove-Item function:Rename-Item
  if ($script:renameCalls -ne 2) { throw "install case 7: expected a retry, got $($script:renameCalls) attempt(s)" }
  Assert-Installed '7 (transient hold)' 'v6'
  Assert-NoResidue '7 (transient hold)'

  # 8. two installs from ONE PowerShell session, the first aside still held by
  # the binary that was running then. $PID is identical across both, so an aside
  # named from $PID alone collides with the undeletable one and reports a
  # perfectly replaceable binary as locked. This is the ordinary re-enrollment
  # path: `irm | iex` gets re-run in the same window.
  $held = Join-Path $work "anyray-connect.exe.old-$PID"
  Set-Content -LiteralPath $held -Value 'still running' -NoNewline
  $script:sweptHeld = $false
  function Remove-Item {
    param([string] $LiteralPath, [switch] $Force, [switch] $Recurse, $ErrorAction)
    # Stands in for a Windows delete refused because the image is loaded.
    if ($LiteralPath -eq $held) { $script:sweptHeld = $true; return }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force -Recurse:$Recurse -ErrorAction SilentlyContinue
  }
  Install-AnyrayBinary -Source (New-Download 'v7') -Destination $bin
  Remove-Item function:Remove-Item
  if (-not $script:sweptHeld) { throw 'install case 8: the sweep never tried the held aside' }
  Assert-Installed '8 (same-session re-run)' 'v7'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $held -Force
  Assert-NoResidue '8 (same-session re-run)'

  Write-Host 'connect.ps1 install: 8/8 cases OK'
}
finally {
  Microsoft.PowerShell.Management\Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
