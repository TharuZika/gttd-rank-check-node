param(
  [string]$NodeTaskName = "Findrhost Rank Check Node",
  [string]$BrowserTaskName = "Findrhost BrowserOS Interactive",
  [string]$TunnelTaskName = "Findrhost Rank Check Tunnel",
  [string]$InstallRoot = "C:\ProgramData\Findrhost\RankCheckNode",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"

foreach ($taskName in @($NodeTaskName, $BrowserTaskName, $TunnelTaskName)) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

if ($RemoveData) {
  if ((Resolve-Path -LiteralPath $InstallRoot -ErrorAction SilentlyContinue).Path -eq "C:\ProgramData\Findrhost\RankCheckNode") {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  else {
    throw "Refusing to remove unexpected path: $InstallRoot"
  }
}

Write-Host "Uninstall step complete."
