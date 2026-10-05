param(
  [string]$NodeTaskName = "Findrhost Rank Check Node",
  [string]$TunnelTaskName = "Findrhost Rank Check Tunnel"
)

$ErrorActionPreference = "Stop"

foreach ($taskName in @($NodeTaskName, $TunnelTaskName)) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Restarted $taskName."
  }
}
