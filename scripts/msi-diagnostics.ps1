# Dot-sourced by the Windows MSI smoke and its failure-reporting step.
function Assert-MsiForeignEngineRefusal {
  param([Parameter(Mandatory = $true)][string]$Path)

  # 1603 alone also passes when Windows Installer fails before our action runs.
  $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
  $action = $lines | Select-String -Pattern '^Action ended .*: SweepMachineState\. Return value 3\.|^CustomAction SweepMachineState returned actual error code [1-9][0-9]*\b'
  if (-not $action) {
    throw 'MSI foreign-engine refusal did not fail SweepMachineState; inspect the preserved MSI log.'
  }
  # A redirected PowerShell error stream reaches the log as a bare CLIXML header,
  # so the cause is readable only from an engine that prints the stdout marker.
  # Absent marker means an older engine, not a wrong cause: warn, never fail.
  $reported = @($lines | Where-Object { $_ -match 'WixQuietExec64:.*ANYRAY-CA-ERROR:' })
  if ($reported.Count -eq 0) {
    Write-Host '::warning::MSI predates the custom-action failure marker; refusal cause is unverified.'
    return
  }
  if (-not ($reported | Where-Object { $_ -match 'A foreign, unsigned binary occupies' })) {
    throw 'MSI foreign-engine refusal reported a cause other than the foreign binary; inspect the preserved MSI log.'
  }
}

function Show-MsiFailureContext {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Warning "MSI log was not created: $Path"
    return
  }
  $lines = @(Get-Content -LiteralPath $Path -ErrorAction Stop)
  $failures = @($lines | Select-String -Pattern 'Return value 3|CustomAction .* returned actual error code|WixQuietExec64:.*(Error|Exception|failed|foreign, unsigned)')
  # Merge overlapping windows; bound console output while retaining full logs in S3.
  $indexes = [System.Collections.Generic.SortedSet[int]]::new()
  foreach ($match in ($failures | Select-Object -First 8)) {
    $start = [Math]::Max(0, $match.LineNumber - 26)
    $end = [Math]::Min($lines.Count - 1, $match.LineNumber + 4)
    for ($i = $start; $i -le $end; $i++) { [void]$indexes.Add($i) }
  }
  if ($indexes.Count -eq 0) {
    Write-Host 'No MSI failure marker found; showing the final 40 lines.'
    for ($i = [Math]::Max(0, $lines.Count - 40); $i -lt $lines.Count; $i++) {
      [void]$indexes.Add($i)
    }
  }
  foreach ($i in $indexes) {
    $line = $lines[$i]
    if ($line.Length -gt 1000) { $line = $line.Substring(0, 1000) + ' [see full MSI log]' }
    Write-Host ('{0}: {1}' -f ($i + 1), $line)
  }
}
