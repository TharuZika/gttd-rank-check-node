param(
  [string]$GatewayUrl = "http://127.0.0.1:8787",
  [string]$ApiToken = "",
  [string]$Country = "US",
  [string]$NodeTaskName = "Findrhost Rank Check Node",
  [string]$TunnelTaskName = "Findrhost Rank Check Tunnel"
)

$ErrorActionPreference = "Stop"

function Get-ResponseHeader {
  param($Response, [string]$Name)
  try {
    $value = $Response.Headers[$Name]
    if ($null -ne $value) {
      return ([string]$value).Trim()
    }
  }
  catch {
    return ""
  }
  return ""
}

function Write-ResponseDiagnostics {
  param($Response, [string]$Label, [switch]$Warning)
  $statusCode = [int]$Response.StatusCode
  $cfRay = Get-ResponseHeader $Response "cf-ray"
  $server = Get-ResponseHeader $Response "server"
  $contentType = Get-ResponseHeader $Response "content-type"
  $cfMitigated = Get-ResponseHeader $Response "cf-mitigated"
  $source = if ($cfMitigated) { "cloudflare-edge" } elseif ($cfRay -or $server -match "cloudflare") { "cloudflare-proxied" } else { "origin-or-unknown" }
  $details = "HTTP $statusCode (source=$source"
  if ($cfRay) { $details += "; cf-ray=$cfRay" }
  if ($cfMitigated) { $details += "; cf-mitigated=$cfMitigated" }
  if ($server) { $details += "; server=$server" }
  if ($contentType) { $details += "; content-type=$contentType" }
  $details += ")"
  if ($Warning) {
    Write-Warning "$Label -> $details"
  }
  else {
    Write-Host "$Label -> $details"
  }
}

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
    $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$GatewayUrl$Path" -Headers $headers -TimeoutSec 10
    Write-ResponseDiagnostics $response "$Path"
  }
  catch {
    $response = $_.Exception.Response
    if ($response) {
      Write-ResponseDiagnostics $response "$Path" -Warning
    }
    else {
      Write-Warning "$Path network failure: unable to reach gateway"
    }
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
