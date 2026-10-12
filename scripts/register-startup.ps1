param(
  [string]$TaskName = "Findrhost Rank Check Node",
  [string]$BrowserTaskName = "Findrhost BrowserOS Interactive",
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ConfigPath = "C:\ProgramData\Findrhost\RankCheckNode\config.json",
  [string]$NodeExe = "node.exe",
  [string]$BrowserOsExePath = "C:\Program Files\BrowserOS\BrowserOS.exe",
  [string]$BrowserUser = ""
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
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $relay = $config.proxyRelay
  if ($null -eq $relay -or $null -eq $relay.port) {
    throw "Config proxyRelay.host and proxyRelay.port are required to derive BrowserOS proxy arguments."
  }
  $relayHost = if ([string]::IsNullOrWhiteSpace([string]$relay.host)) { "127.0.0.1" } else { [string]$relay.host }
  if ($relayHost -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
    throw "BrowserOS must use a localhost proxy relay. Refusing proxyRelay host '$relayHost'."
  }
  $relayPort = [int]$relay.port
  if ($relayPort -lt 1 -or $relayPort -gt 65535) {
    throw "Config proxyRelay.port must be between 1 and 65535."
  }
  $relayHostForUrl = if ($relayHost.Contains(":") -and -not $relayHost.StartsWith("[")) { "[$relayHost]" } else { $relayHost }
  $browserOsArgs = "--proxy-server=http://$relayHostForUrl`:$relayPort"
  $browserAction = New-ScheduledTaskAction -Execute $BrowserOsExePath -Argument $browserOsArgs
  $browserTrigger = New-ScheduledTaskTrigger -AtLogOn -User $BrowserUser
  $browserSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $browserPrincipal = New-ScheduledTaskPrincipal -UserId $BrowserUser -LogonType InteractiveToken -RunLevel Limited
  Register-ScheduledTask -TaskName $BrowserTaskName -Action $browserAction -Trigger $browserTrigger -Settings $browserSettings -Principal $browserPrincipal -Force | Out-Null
}

Write-Host "Registered $TaskName."
if ($BrowserUser -ne "") {
  Write-Host "Registered $BrowserTaskName for restricted user $BrowserUser with $browserOsArgs."
}
else {
  Write-Warning "BrowserOS task skipped. Re-run with -BrowserUser after creating the restricted desktop account."
}
