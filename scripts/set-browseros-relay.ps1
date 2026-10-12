param(
  [string]$ConfigPath = "C:\ProgramData\Findrhost\RankCheckNode\config.json"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Config not found at $ConfigPath."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$relay = $config.proxyRelay
if ($null -eq $relay -or $null -eq $relay.port) {
  throw "Config proxyRelay.host and proxyRelay.port are required."
}

$relayHost = if ([string]::IsNullOrWhiteSpace([string]$relay.host)) { "127.0.0.1" } else { [string]$relay.host }
if ($relayHost -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
  throw "Refusing to write a non-local BrowserOS proxy."
}

$port = [int]$relay.port
if ($port -lt 1 -or $port -gt 65535) {
  throw "Config proxyRelay.port must be between 1 and 65535."
}

$relayHostForUrl = if ($relayHost.Contains(":") -and -not $relayHost.StartsWith("[")) { "[$relayHost]" } else { $relayHost }
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
Set-ItemProperty -Path $regPath -Name ProxyServer -Value "$relayHostForUrl`:$port"
Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 1
Set-ItemProperty -Path $regPath -Name ProxyOverride -Value "<local>"

Write-Host "Configured the current BrowserOS user to use the local relay $relayHostForUrl`:$port."
Write-Host "No Webshare address, username, password, or API key was written to the registry."
