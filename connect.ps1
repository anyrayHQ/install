<#
  Anyray zero-install developer connect (Windows / PowerShell).

  Recommended (passes the setup link as an argument):
    & ([scriptblock]::Create((irm https://app.anyray.ai/connect.ps1))) "<setup-link-or-gateway-url>" [flags]

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
$base  = "https://github.com/$repo/releases/latest/download"
$asset = 'anyray-connect-windows-x64.exe'  # Bun compiles a single x64 Windows target

# Args: prefer real script args; fall back to $env:ANYRAY_CONNECT for the `| iex` form.
$connectArgs = @($args)
if ($connectArgs.Count -eq 0 -and $env:ANYRAY_CONNECT) {
  $connectArgs = $env:ANYRAY_CONNECT -split '\s+' | Where-Object { $_ -ne '' }
}

$tmp = Join-Path $env:TEMP ("anyray-connect-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$bin = Join-Path $tmp 'anyray-connect.exe'

try {
  Write-Host "anyray-connect: downloading $asset..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $bin -UseBasicParsing

  # Verify the checksum from the same release (best-effort).
  try {
    $sumsPath = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
    $want = (Get-Content $sumsPath | ForEach-Object {
      $p = $_ -split '\s+'
      if ($p.Length -ge 2 -and ($p[1].TrimStart('*') -eq $asset)) { $p[0] }
    } | Select-Object -First 1)
    if ($want) {
      $got = (Get-FileHash -Algorithm SHA256 -Path $bin).Hash.ToLower()
      if ($got -ne $want.ToLower()) { throw "checksum mismatch for $asset - refusing to run" }
    }
  } catch [System.Net.WebException] {
    # No SHA256SUMS published yet — proceed without verification.
  }

  & $bin @connectArgs
  exit $LASTEXITCODE
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
