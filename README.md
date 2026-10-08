# GTTD Rank Check Node

Windows VPS service for POI rank checks through BrowserOS and a country-selectable proxy relay.

## Local / Direct Clone

```powershell
npm install
Copy-Item .\config.example.json .\config.json
# Skip the next line if .env already exists.
Copy-Item .\.env.example .\.env
notepad .\config.json
notepad .\.env
npm run dev
```

Set a unique `apiToken` of at least 32 bytes in `config.json`. For a direct clone, you can also set `logging.directory` to `logs`. The local `config.json` and `.env` files are ignored by Git.

For a production-style start that compiles first:

```powershell
npm run prod
```

## Production VPS Install

Open PowerShell as Administrator, then run:

```powershell
.\scripts\install.ps1
notepad C:\ProgramData\Findrhost\RankCheckNode\config.json
notepad C:\ProgramData\Findrhost\RankCheckNode\.env
.\scripts\register-startup.ps1 -BrowserUser "<restricted-browser-user>"
```

Configuration lookup order is `RANK_NODE_CONFIG`, `C:\ProgramData\Findrhost\RankCheckNode\config.json`, then the project-local `config.json`. ProgramData remains preferred when both production and local files exist.

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the Windows VPS setup, BrowserOS account, tunnel configuration, diagnostics, and acceptance evidence checklist.

## API

- `GET /health`
- `GET /ready`
- `GET /countries`
- `GET /proxy?country=US`
- `GET|POST /browser`

All endpoints except `/health` require `Authorization: Bearer <apiToken>`.

`/countries` reads the countries allocated to the configured Webshare plan. Calling `/proxy?country=XX` selects a numeric sticky session, verifies the country and egress IP, and retries up to three sessions when the previous IP is returned.
