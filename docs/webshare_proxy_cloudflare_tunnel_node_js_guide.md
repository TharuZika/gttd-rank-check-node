# Controlling Webshare Proxies via Node.js on a Windows VPS (Cloudflare Tunnel)

> Project-specific note: `gttd-rank-check-node` uses exact allocated Backbone records returned by Webshare's proxy-list API. The dynamic username examples in Method A do not apply to plans that report `no_proxies_allocated` for synthesized usernames. For this service, connect through `p.webshare.io` with the selected record's exact `username` and `password`; do not use its Direct-mode `proxy_address`/`port`.

This guide provides end-to-end instructions for configuring dynamic proxy routing using **Webshare** inside a **Node.js** service hosted on a **Windows VPS** and exposed via **Cloudflare Tunnel (`cloudflared`)**.

---

## 1. System Architecture Overview

```
[ Incoming Requests ]
         │
         ▼
[ Cloudflare Edge ] 
         │ (Encrypted Tunnel)
         ▼
[ Windows VPS : cloudflared.exe ]
         │ (Reverse Proxy to localhost)
         ▼
[ Node.js Application (Express / Fastify) ]
         │
         │ (Outbound proxy request with country/rotation parameters)
         ▼
[ Webshare Gateway: p.webshare.io:80 / 1080 ]
         │
         ▼
[ Target External Websites / APIs ]
```

- **Inbound Path:** Client $\rightarrow$ Cloudflare Tunnel $\rightarrow$ Localhost port on Windows VPS.
- **Outbound Path:** Node.js $\rightarrow$ Webshare Backbone or Direct Proxy pool $\rightarrow$ External Target.
- **Windows System Config:** No system-level proxy modification is needed; all proxy assignments are handled programmatically within Node.js.

---

## 2. Webshare Proxy Control Strategies

Webshare supports two primary modes for controlling egress IP addresses and target countries:

| Feature | Method A: Backbone Gateway (Recommended) | Method B: Webshare REST API |
| :--- | :--- | :--- |
| **Best For** | Rotating residential or dynamic datacenter pools | Managing a static/fixed list of datacenter IPs |
| **Switching Mechanism** | Dynamic username string per HTTP request | HTTP calls to `/api/v2/proxy/...` endpoints |
| **Latency** | Low (no API query prior to request) | Higher (requires API calls to query or refresh IPs) |
| **State Maintenance** | Stateless (handled in URL/credentials) | Stateful (requires storing/tracking proxy IDs) |

---

## 3. Implementation: Method A (Backbone Gateway)

Webshare's backbone gateway (`p.webshare.io`) allows you to dynamically set the target country and rotation mode purely through the proxy authentication username.

### Username Formatting Rules

```
http://<USERNAME>-<COUNTRY_CODE>-<MODE>:<PASSWORD>@p.webshare.io:80
```

- **Country code:** ISO 2-letter format (e.g., `us`, `de`, `gb`, `jp`, `ca`).
- **Mode:**
  - `-rotate`: Fetches a fresh IP address on every HTTP request.
  - `-<session_id>`: Keeps a sticky IP alive for a specific session token (e.g., `-session12345`).

### Project Setup

In your project directory on the Windows VPS:

```powershell
npm init -y
npm install express axios https-proxy-agent dotenv
```

### Server Code: `server.js`

```javascript
import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const WEBSHARE_USER = process.env.WEBSHARE_USER;
const WEBSHARE_PASS = process.env.WEBSHARE_PASS;
const BACKBONE_HOST = "p.webshare.io";
const BACKBONE_PORT = 80;

/**
 * Builds an HttpsProxyAgent configured for dynamic Webshare parameters.
 * @param {Object} options
 * @param {string} [options.country] - ISO 2-letter country code (e.g., "us", "de").
 * @param {boolean} [options.rotate=true] - Force IP rotation on each call.
 * @param {string} [options.session] - Sticky session identifier.
 * @returns {HttpsProxyAgent}
 */
function getWebshareAgent({ country = "us", rotate = true, session = null }) {
  let userString = `${WEBSHARE_USER}-${country.toLowerCase()}`;

  if (session) {
    userString += `-${session}`;
  } else if (rotate) {
    userString += "-rotate";
  }

  const proxyUrl = `http://${userString}:${WEBSHARE_PASS}@${BACKBONE_HOST}:${BACKBONE_PORT}`;
  return new HttpsProxyAgent(proxyUrl);
}

// Endpoint: Test outbound IP and location via Webshare
app.get("/api/check-ip", async (req, res) => {
  const country = req.query.country || "us";
  const rotate = req.query.rotate !== "false";
  const session = req.query.session || null;

  try {
    const agent = getWebshareAgent({ country, rotate, session });

    // Query an IP echo service through the proxy
    const response = await axios.get("https://ipinfo.io/json", {
      httpsAgent: agent,
      proxy: false, // Prevents axios from reading default environment proxy settings
      timeout: 10000,
    });

    res.json({
      success: true,
      requested_country: country,
      detected_ip: response.data.ip,
      ipinfo: response.data,
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message,
      details: error.response?.data || null,
    });
  }
});

// Endpoint: Forward custom requests through the dynamically selected proxy
app.post("/api/proxy-fetch", async (req, res) => {
  const { targetUrl, country = "us", rotate = true, session = null, method = "GET", payload = {} } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing targetUrl parameter." });
  }

  try {
    const agent = getWebshareAgent({ country, rotate, session });
    const response = await axios({
      url: targetUrl,
      method,
      data: payload,
      httpsAgent: agent,
      proxy: false,
      timeout: 15000,
    });

    res.status(response.status).json({
      status: response.status,
      data: response.data,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      targetResponse: error.response?.data || null,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
```

---

## 4. Implementation: Read-only Webshare REST API Integration

Use this method to inspect and select individual proxies already allocated to your account. `gttd-rank-check-node` must not call proxy replacement, refresh, or other account-mutating APIs.

### Common API Endpoints

- **Allocated Backbone Proxy List:** `GET https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&page=1&page_size=100`

The proxy-replacement endpoint is intentionally excluded. Rotation in this service means selecting another existing allocated record; it does not mutate the Webshare account.

### Controller Implementation: `webshareApi.js`

```javascript
import axios from "axios";

const API_BASE = "https://proxy.webshare.io/api/v2";

export class WebshareClient {
  constructor(apiKey) {
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Retrieves already allocated Backbone proxies filtered by country.
   * @param {string[]} countries Array of ISO country codes (e.g. ['US', 'FR'])
   */
  async listProxiesByCountry(countries = []) {
    const params = {
      mode: "backbone",
      page_size: 100,
    };
    if (countries.length > 0) {
      params.country_code__in = countries.join(",");
    }

    const res = await this.client.get("/proxy/list/", { params });
    return res.data.results;
  }
}
```

---

## 5. Cloudflare Tunnel Configuration on Windows VPS

Ensure your tunnel points to the local port hosting your Node.js application.

### Step 1: Install `cloudflared`
Download the official Windows 64-bit MSI or binary from Cloudflare and extract it (e.g., `C:\cloudflared\cloudflared.exe`).

### Step 2: Authenticate and Create Tunnel
Open PowerShell as Administrator:

```powershell
# Login to Cloudflare account
.\cloudflared.exe tunnel login

# Create tunnel
.\cloudflared.exe tunnel create node-proxy-tunnel
```

### Step 3: Configure `config.yml`
Save the file at `C:\Users\<YourUser>\.cloudflared\config.yml` or next to the executable:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: C:\Users\<YourUser>\.cloudflared\<TUNNEL_UUID>.json

ingress:
  - hostname: node-proxy.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

### Step 4: Route DNS and Run as a Windows Service

```powershell
# Route DNS hostname
.\cloudflared.exe tunnel route dns node-proxy-tunnel node-proxy.yourdomain.com

# Install and start Windows Service
.\cloudflared.exe service install
Start-Service cloudflared
```

---

## 6. Verification and Testing

You can now test IP location and rotation remotely through your public Cloudflare domain.

### 1. Test Exit IP for the United States (Rotated)
```bash
curl -X GET "https://node-proxy.yourdomain.com/api/check-ip?country=us&rotate=true"
```

### 2. Test Exit IP for Germany (Sticky Session)
```bash
curl -X GET "https://node-proxy.yourdomain.com/api/check-ip?country=de&session=session_abc123"
```

### 3. Forward Requests Dynamically
```bash
curl -X POST "https://node-proxy.yourdomain.com/api/proxy-fetch" \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl": "https://httpbin.org/ip",
    "country": "gb",
    "rotate": true
  }'
```
