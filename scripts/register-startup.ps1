param(
  [string]$TaskName = "Findrhost Rank Check Node",
  [string]$BrowserTaskName = "Findrhost BrowserOS Interactive",
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ConfigPath = "C:\ProgramData\Findrhost\RankCheckNode\config.json",
  [string]$NodeExe = "node.exe",
  [string]$BrowserOsExePath = "C:\Program Files\BrowserOS\BrowserOS.exe",
  [string]$BrowserUser = "",
  [string]$BrowserOsArgs = "--proxy-server=http://127.0.0.1:8788"
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session."
  }
}

Assert-Admin

$entryPoint = Join-Path $SourceRoot "dist\src\index.js"
if (-not (Test-Path -LiteralPath $entryPoint)) {
  throw "Build output not found at $entryPoint. Run scripts\install.ps1 first."
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config not found at $ConfigPath."
}

$nodeAction = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$entryPoint`"" -WorkingDirectory $SourceRoot
$nodeTrigger = New-ScheduledTaskTrigger -AtStartup
$nodeSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$nodePrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $nodeAction -Trigger $nodeTrigger -Settings $nodeSettings -Principal $nodePrincipal -Force | Out-Null

if ($BrowserUser -ne "") {
  if (-not (Test-Path -LiteralPath $BrowserOsExePath)) {
    throw "BrowserOS executable not found at $BrowserOsExePath."
  }
  $browserAction = New-ScheduledTaskAction -Execute $BrowserOsExePath -Argument $BrowserOsArgs
  $browserTrigger = New-ScheduledTaskTrigger -AtLogOn -User $BrowserUser
  $browserSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $BrowserTaskName -Action $browserAction -Trigger $browserTrigger -Settings $browserSettings -Force | Out-Null
}

Write-Host "Registered $TaskName."
if ($BrowserUser -ne "") {
  Write-Host "Registered $BrowserTaskName for $BrowserUser."
}
else {
  Write-Warning "BrowserOS task skipped. Re-run with -BrowserUser after creating the restricted desktop account."
}
