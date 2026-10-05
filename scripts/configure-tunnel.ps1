param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Cloudflare", "Ngrok")]
  [string]$Provider,
  [string]$TaskName = "Findrhost Rank Check Tunnel",
  [string]$GatewayUrl = "http://127.0.0.1:8787",
  [string]$CloudflaredExe = "cloudflared.exe",
  [string]$CloudflareTunnelName = "findrhost-rank-check-node",
  [string]$CloudflareConfigPath = "C:\ProgramData\Findrhost\RankCheckNode\cloudflared.yml",
  [string]$CloudflareCredentialsFile = "",
  [string]$NgrokExe = "ngrok.exe",
  [string]$NgrokDomain = ""
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

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

if ($Provider -eq "Cloudflare") {
  if ($CloudflareCredentialsFile -ne "") {
    $configRoot = Split-Path -Parent $CloudflareConfigPath
    New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
    @"
tunnel: $CloudflareTunnelName
credentials-file: $CloudflareCredentialsFile
ingress:
  - service: $GatewayUrl
  - service: http_status:404
"@ | Set-Content -LiteralPath $CloudflareConfigPath -Encoding UTF8
    $action = New-ScheduledTaskAction -Execute $CloudflaredExe -Argument "tunnel --config `"$CloudflareConfigPath`" run"
  }
  else {
    Write-Warning "No -CloudflareCredentialsFile provided. Registering a quick tunnel command; use a named tunnel config for production DNS."
    $action = New-ScheduledTaskAction -Execute $CloudflaredExe -Argument "tunnel --url $GatewayUrl"
  }
}
else {
  $args = "http $GatewayUrl"
  if ($NgrokDomain -ne "") {
    $args = "http --domain=$NgrokDomain $GatewayUrl"
  }
  $action = New-ScheduledTaskAction -Execute $NgrokExe -Argument $args
}

$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

Write-Host "Registered $Provider tunnel task for $GatewayUrl. Ensure the provider CLI is already authenticated."
