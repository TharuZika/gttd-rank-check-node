# Windows VPS BrowserOS and Proxy Node Runbook

## Purpose

This service exposes the POI ranking node contract expected by the dashboard:

- `GET /health` without auth
- `GET /ready` with bearer auth
- `GET /countries` with bearer auth
- `GET /proxy?country=US` with bearer auth
- `GET|POST /browser` with bearer auth, proxied to BrowserOS MCP

Only the Node gateway should be exposed through Cloudflare Tunnel or ngrok. BrowserOS MCP and the proxy relay stay on `127.0.0.1`.

## Install

1. Open elevated PowerShell.
2. Run `scripts\install.ps1`.
3. Edit `C:\ProgramData\Findrhost\RankCheckNode\config.json`.
4. Use a token with at least 32 random bytes.
5. Set the proxy provider template, keeping `{country}` and optionally `{session}`.
6. Confirm BrowserOS MCP URL, executable path, and `browserOs.requestTimeoutMs`.
7. Run `scripts\register-startup.ps1 -BrowserUser "<restricted-user>"`.

## BrowserOS Account

Use a dedicated restricted Windows account for BrowserOS. To create it and enable automatic logon:

```powershell
$password = Read-Host -AsSecureString "BrowserOS account password"
scripts\configure-browseros-account.ps1 -BrowserUser "rank-browser" -BrowserUserPassword $password -CreateUser -EnableAutoLogon
```

Automatic logon stores Windows logon credentials. Use this only for the restricted BrowserOS account on the VPS.

## Tunnel

Cloudflare:

```powershell
scripts\configure-tunnel.ps1 -Provider Cloudflare -CloudflareTunnelName "findrhost-rank-check-node" -CloudflareCredentialsFile "C:\Users\<user>\.cloudflared\<tunnel-id>.json"
```

ngrok:

```powershell
scripts\configure-tunnel.ps1 -Provider Ngrok -NgrokDomain "rank-node.example.com"
```

Only one tunnel task is registered by the script. Re-running it replaces the previous tunnel task.

## Update

Run:

```powershell
scripts\update.ps1
```

The script installs declared dependencies, rebuilds the service, and restarts the Node scheduled task when it exists.

## Dashboard Setup

In the existing POI ranking modal:

- Host URL: the public Cloudflare/ngrok HTTPS URL
- Token: the same `apiToken` from the VPS config
- Country: `US` for initial acceptance

The backend calls `/proxy?country=US` before using `/browser`, so active country state does not need to survive service restarts.

## Diagnostics

Run:

```powershell
scripts\diagnose.ps1 -ApiToken "<token>"
```

Expected production checks:

- `/health` returns `200`.
- `/ready` returns `503` before a country is selected, then `200` after `/proxy?country=US`.
- `/countries` includes `US`.
- Logs under `C:\ProgramData\Findrhost\RankCheckNode\logs` do not contain API tokens, proxy passwords, or full credentialed proxy URLs.

## Acceptance Evidence

Capture one real United States POI ranking check:

- Dashboard session ID
- Start and finish timestamps
- Sanitized node logs
- Verified US egress IP/country
- Rank result or explicit not-indexed result
- Browser/result screenshot from the dashboard flow
