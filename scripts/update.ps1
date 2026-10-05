param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$NodeTaskName = "Findrhost Rank Check Node"
)

$ErrorActionPreference = "Stop"

Push-Location $SourceRoot
try {
  npm install
  npm run build
}
finally {
  Pop-Location
}

$task = Get-ScheduledTask -TaskName $NodeTaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $NodeTaskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $NodeTaskName
  Write-Host "Updated and restarted $NodeTaskName."
}
else {
  Write-Warning "$NodeTaskName is not registered. Run scripts\register-startup.ps1 after update."
}
