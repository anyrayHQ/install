# Dot-sourced by the Windows MSI smoke's failure-reporting step.
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
