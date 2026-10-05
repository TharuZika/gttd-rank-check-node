param(
  [Parameter(Mandatory = $true)]
  [string]$BrowserUser,
  [Parameter(Mandatory = $true)]
  [securestring]$BrowserUserPassword,
  [switch]$CreateUser,
  [switch]$EnableAutoLogon
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

if ($CreateUser) {
  if (-not (Get-LocalUser -Name $BrowserUser -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $BrowserUser -Password $BrowserUserPassword -AccountNeverExpires -PasswordNeverExpires | Out-Null
  }
  Add-LocalGroupMember -Group "Users" -Member $BrowserUser -ErrorAction SilentlyContinue
}

if ($EnableAutoLogon) {
  $credential = [pscredential]::new($BrowserUser, $BrowserUserPassword)
  $plainPassword = $credential.GetNetworkCredential().Password
  $winlogonPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  Set-ItemProperty -Path $winlogonPath -Name "AutoAdminLogon" -Value "1"
  Set-ItemProperty -Path $winlogonPath -Name "DefaultUserName" -Value $BrowserUser
  Set-ItemProperty -Path $winlogonPath -Name "DefaultPassword" -Value $plainPassword
  Write-Warning "Automatic logon stores credentials for Windows logon. Use a restricted BrowserOS-only account."
}

Write-Host "BrowserOS account step complete."
