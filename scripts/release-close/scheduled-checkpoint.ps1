$ErrorActionPreference = 'Stop'
try {
  Set-Location -LiteralPath 'C:\Users\goura\Desktop\Skyline-Website'
  $checkpointNode = (Get-Command node.exe -ErrorAction Stop).Source
  & $checkpointNode 'scripts/release-close/collect-production-checkpoint.mjs' '--approved-recovery-export' '--approved-scheduled-backup' *> $null
  if ($LASTEXITCODE -ne 0) { exit 1 }
  & $checkpointNode 'scripts/release-close/checkpoint-retention.mjs' *> $null
  exit $LASTEXITCODE
} catch { exit 1 }
