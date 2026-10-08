# GTTD Rank Check Node

Windows VPS service for POI rank checks through BrowserOS and a country-selectable proxy relay.

## Quick Start

```powershell
npm install
npm test
copy config.example.json C:\ProgramData\Findrhost\RankCheckNode\config.json
copy .env.example C:\ProgramData\Findrhost\RankCheckNode\.env
notepad C:\ProgramData\Findrhost\RankCheckNode\config.json
notepad C:\ProgramData\Findrhost\RankCheckNode\.env
scripts\install.ps1
scripts\register-startup.ps1 -BrowserUser "<restricted-browser-user>"
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the Windows VPS setup, BrowserOS account, tunnel configuration, diagnostics, and acceptance evidence checklist.

## API

- `GET /health`
- `GET /ready`
- `GET /countries`
- `GET /proxy?country=US`
- `GET|POST /browser`

All endpoints except `/health` require `Authorization: Bearer <apiToken>`.

`/countries` reads the countries allocated to the configured Webshare plan. Calling `/proxy?country=XX` selects a numeric sticky session, verifies the country and egress IP, and retries up to three sessions when the previous IP is returned.
