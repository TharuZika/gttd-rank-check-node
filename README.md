# GTTD Rank Check Node

Windows VPS service for POI rank checks through BrowserOS and a country-selectable proxy relay.

## Quick Start

```powershell
npm install
npm test
copy config.example.json C:\ProgramData\Findrhost\RankCheckNode\config.json
notepad C:\ProgramData\Findrhost\RankCheckNode\config.json
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
