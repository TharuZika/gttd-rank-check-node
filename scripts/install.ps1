param(
  [string]$InstallRoot = "C:\ProgramData\Findrhost\RankCheckNode",
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ConfigPath = "C:\ProgramData\Findrhost\RankCheckNode\config.json",
  [string]$EnvPath = "C:\ProgramData\Findrhost\RankCheckNode\.env"
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

$logRoot = Join-Path $InstallRoot "logs"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Copy-Item -LiteralPath (Join-Path $SourceRoot "config.example.json") -Destination $ConfigPath
  Write-Warning "Created $ConfigPath from config.example.json. Edit apiToken and browserOs before starting the service."
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  Copy-Item -LiteralPath (Join-Path $SourceRoot ".env.example") -Destination $EnvPath
  Write-Warning "Created $EnvPath from .env.example. Add the Webshare proxy credentials and API key before starting the service."
}

icacls $InstallRoot /inheritance:r | Out-Null
icacls $InstallRoot /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "${env:USERNAME}:(OI)(CI)F" | Out-Null

Push-Location $SourceRoot
try {
  npm install
  npm run build
}
finally {
  Pop-Location
}

Write-Host "Install complete. Next run scripts\register-startup.ps1 after editing $ConfigPath and $EnvPath."
