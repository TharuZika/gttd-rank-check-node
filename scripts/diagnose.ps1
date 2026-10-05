param(
  [string]$GatewayUrl = "http://127.0.0.1:8787",
  [string]$ApiToken = "",
  [string]$Country = "US",
  [string]$NodeTaskName = "Findrhost Rank Check Node",
  [string]$TunnelTaskName = "Findrhost Rank Check Tunnel"
)

$ErrorActionPreference = "Stop"

function Invoke-Gateway {
  param([string]$Path, [switch]$Auth)
  $headers = @{}
  if ($Auth) {
    if ($ApiToken -eq "") {
      Write-Warning "Skipping $Path because -ApiToken was not provided."
      return
    }
    $headers["Authorization"] = "Bearer $ApiToken"
  }
  try {
    Invoke-RestMethod -Method Get -Uri "$GatewayUrl$Path" -Headers $headers -TimeoutSec 10
  }
  catch {
    Write-Warning "$Path failed: $($_.Exception.Message)"
  }
}

Write-Host "Scheduled tasks"
Get-ScheduledTask -TaskName $NodeTaskName,$TunnelTaskName -ErrorAction SilentlyContinue | Select-Object TaskName,State

Write-Host "Health"
Invoke-Gateway -Path "/health"

Write-Host "Ready"
Invoke-Gateway -Path "/ready" -Auth

Write-Host "Countries"
Invoke-Gateway -Path "/countries" -Auth

Write-Host "Proxy switch"
Invoke-Gateway -Path "/proxy?country=$Country" -Auth

Write-Host "Ready after proxy switch"
Invoke-Gateway -Path "/ready" -Auth

Write-Host "Listening ports"
Get-NetTCPConnection -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 8787,8788 } |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
