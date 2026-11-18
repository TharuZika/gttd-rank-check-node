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

function Get-SafeGatewayErrorDetails {
  param($Response)
  $body = ""
  try {
    if ($null -ne $Response.Content) {
      $body = [string]$Response.Content
    }
    elseif ($Response.GetResponseStream) {
      $stream = $Response.GetResponseStream()
      if ($stream) {
        $reader = [System.IO.StreamReader]::new($stream)
        try {
          $body = $reader.ReadToEnd()
        }
        finally {
          $reader.Dispose()
        }
      }
    }
  }
  catch {
    return @()
  }

  if ([string]::IsNullOrWhiteSpace($body)) {
    return @()
  }

  try {
    $payload = $body | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    return @()
  }

  $details = @()
  if ($payload.error -is [string] -and $payload.error -match '^[A-Za-z0-9_]{1,80}$') {
    $details += "gateway-error=$($payload.error)"
  }
  if ($payload.browser -and $payload.browser.error -is [string] -and $payload.browser.error -match '^[A-Za-z0-9_]{1,80}$') {
    $details += "browser-error=$($payload.browser.error)"
  }
  if ($payload.browser -and $payload.browser.statusCode -is [int]) {
    $details += "browser-status=$($payload.browser.statusCode)"
  }
  return $details
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
  foreach ($detail in Get-SafeGatewayErrorDetails $Response) { $details += "; $detail" }
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
