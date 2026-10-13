# Windows VPS BrowserOS and Proxy Node Runbook

## Purpose

This service exposes the POI ranking node contract expected by the dashboard:

- `GET /health` without auth
- `GET /` or `/diagnostics` for the local diagnostics page (the page itself is public; API actions still require the bearer token)
- `GET /ready` with bearer auth
- `GET /countries` with bearer auth
- `GET /mcp-status` with bearer auth
- `GET /proxy?country=US` with bearer auth
- `GET|POST /browser` with bearer auth, proxied to BrowserOS MCP

Only the Node gateway should be exposed through Cloudflare Tunnel or ngrok. BrowserOS MCP and the proxy relay stay on `127.0.0.1`.

## Install

1. Open elevated PowerShell.
2. Run `scripts\install.ps1`.
3. Edit `C:\ProgramData\Findrhost\RankCheckNode\config.json`.
4. Edit `C:\ProgramData\Findrhost\RankCheckNode\.env` with the Webshare values copied from `.env.example`.
5. Use a gateway API token with at least 32 random bytes.
6. Confirm BrowserOS MCP URL, executable path, and `browserOs.requestTimeoutMs`.
7. Run `scripts\register-startup.ps1 -BrowserUser "<restricted-user>"`. The script reads `proxyRelay.host` and `proxyRelay.port` and derives `--proxy-server=http://127.0.0.1:<relayPort>` instead of hardcoding port `8788`.

The required Webshare variables are `WEBSHARE_MODE` (`direct` or `backbone`), `WEBSHARE_USERNAME`, `WEBSHARE_PASSWORD`, `WEBSHARE_API_KEY`, and `DEFAULT_COUNTRY`. Backbone mode additionally requires `WEBSHARE_HOST` and `WEBSHARE_PORT`; direct mode takes `proxy_address` and `port` from each allocated API record. Set `WEBSHARE_PLAN_ID` when the API key has multiple plans and the desired plan is not the account default. A partial Webshare environment is rejected at startup; if none of these variables are present, the legacy `proxyProvider.upstreamUrlTemplate` configuration remains available.

In backbone mode, the service uses each record's exact `username` and `password` through `WEBSHARE_HOST:WEBSHARE_PORT` (normally `p.webshare.io:80`). In direct mode, it uses each record's `proxy_address:port`. In both modes the Node relay injects `Proxy-Authorization`; BrowserOS and Windows must never receive direct Webshare credentials. `WEBSHARE_USERNAME` and `WEBSHARE_PASSWORD` remain required for backward-compatible environment validation, but API-returned record credentials are used for relay connections. Set `WEBSHARE_PLAN_ID` explicitly when possible so selection cannot move to another plan.

Never commit the production `.env` or `config.json`. If credentials were previously committed, rotate the Webshare proxy password and API key because deleting the working-tree file does not remove values from Git history.

### Running Directly From a Clone

The service first checks `RANK_NODE_CONFIG`, then the ProgramData config, then a project-local `config.json`. To run without installing the scheduled service:

```powershell
npm install
Copy-Item .\config.example.json .\config.json
# Skip this copy when the project already has a configured .env file.
Copy-Item .\.env.example .\.env
notepad .\config.json
notepad .\.env
npm run dev
```

Use `npm run prod` to build and start the compiled service. Set `logging.directory` to `logs` in a project-local config if the current Windows user cannot write to the ProgramData log directory.

`RANK_NODE_CONFIG` must point to a JSON configuration file such as `D:\path\to\gttd-rank-check-node\config.json`; do not point it to `dist\src\config.js`. When running directly from the clone, the project-local `.env` is used if the ProgramData `.env` does not exist.

If no config exists, startup exits with a `config_not_found` message listing the accepted locations instead of an unhandled `ENOENT` stack trace.

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

Existing installations that are adopting Webshare mode must perform this one-time migration before restarting:

```powershell
copy .env.example C:\ProgramData\Findrhost\RankCheckNode\.env
notepad C:\ProgramData\Findrhost\RankCheckNode\.env
```

Replace every placeholder with the rotated Webshare credentials and API key. Installations intentionally staying on the legacy `proxyProvider.upstreamUrlTemplate` mode should not create the `.env` file.

Then run:

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

For a browser-based check, open the gateway URL at `/diagnostics` (or `/`). Enter the configured node API token in the page without saving it, then use **Check BrowserOS MCP** for the MCP handshake or **Test proxy + egress** for the complete Webshare, Node, and BrowserOS verification. The page does not display or store Webshare credentials.

Run:

```powershell
scripts\diagnose.ps1 -ApiToken "<token>"
```

Expected production checks:

- `/health` returns `200`.
- `/ready` returns `503` before a country is selected, then `200` after `/proxy?country=US`.
- `/countries` includes the countries allocated to the configured plan (including `US` when it is allocated).
- `/countries` contains every country currently allocated to the selected Webshare plan. The list is cached for five minutes; a stale valid cache is allowed only for `/countries` during temporary Webshare API failures.
- `/proxy?country=US` forces a fresh Webshare list, selects a valid allocated US record, updates the local relay, and returns sanitized `upstream`, `nodeEgress`, and `browserEgress` data. A response from Webshare activity with `no_proxies_allocated` usually means a synthesized or obsolete username was used.
- `/proxy?country=US` fails and leaves `/browser` blocked unless both Node and BrowserOS egress checks report the requested country and an observed IP. `/ready` is `200` only after that activation succeeds.
- `/proxy?country=US` returns `rotationAttempts` and `ipChanged`. `ipChanged` is `null` for the first activation, `true` for a changed IP, and `false` when all three verified attempts returned the previous IP.
- Logs under `C:\ProgramData\Findrhost\RankCheckNode\logs` do not contain API tokens, proxy passwords, or full credentialed proxy URLs.

### Terminal Logs

When the Node service starts, the terminal prints readable logs for:

- `proxy_relay_status` with the local relay endpoint and `up` status.
- `browseros_mcp_status` with `up` or `down`, plus the MCP response status or sanitized error.
- `gateway_up` with the gateway host and listening port.

During normal operation, each request prints `request_received` and `request_completed` events with the request ID, method, pathname, response status, and duration. Client errors and server errors are printed as warnings or errors. Proxy and BrowserOS MCP startup status checks are not repeated for every request.

Country activation prints `proxy_country_activated`, `proxy_ip_changed`, or `proxy_ip_unchanged`. An unchanged IP is a warning but does not stop the bulk check after three successful country-verification attempts. A country mismatch, BrowserOS timeout/mismatch, or unavailable country list returns an error and prevents BrowserOS work from starting. BrowserOS runs under the restricted interactive account and uses only the local relay. If a registry diagnostic is needed, run `scripts\set-browseros-relay.ps1` as that user; it writes only the local relay to that user's `HKCU` and never writes Webshare credentials.

If an upstream CONNECT is rejected, `proxy_upstream_connect_rejected` includes only the HTTP status code (for example `407`). It does not include the proxy username, password, authorization header, or upstream response headers.

Terminal and file logs redact API tokens, authorization values, proxy credentials, and credentialed proxy URLs. Request bodies are not logged.

## Acceptance Evidence

Capture one real United States POI ranking check:

- Dashboard session ID
- Start and finish timestamps
- Sanitized node logs
- Verified US egress IP/country
- Rank result or explicit not-indexed result
- Browser/result screenshot from the dashboard flow
