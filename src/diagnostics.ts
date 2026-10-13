export const diagnosticsHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rank Check Node Diagnostics</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #10151d; color: #e8edf5; }
    main { width: min(920px, calc(100% - 32px)); margin: 32px auto; }
    h1 { margin-bottom: 8px; font-size: 28px; }
    p { color: #aeb8c8; }
    .card { background: #18212d; border: 1px solid #2b394b; border-radius: 12px; padding: 18px; margin-top: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; color: #aeb8c8; font-size: 13px; }
    input, button { border-radius: 8px; border: 1px solid #40516a; font: inherit; }
    input { background: #0f151e; color: #f4f7fb; padding: 10px; }
    button { background: #2e75d6; color: white; padding: 10px 13px; cursor: pointer; }
    button.secondary { background: #263448; }
    button:disabled { cursor: wait; opacity: .6; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
    #status { font-weight: 600; }
    #output { min-height: 180px; white-space: pre-wrap; overflow: auto; background: #0b1017; border-radius: 8px; padding: 14px; color: #c9f3d0; }
    .hint { font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>Rank Check Node Diagnostics</h1>
    <p>Use this page to check BrowserOS MCP connectivity and validate the selected proxy egress. Credentials are kept only in this page memory.</p>
    <section class="card">
      <div class="grid">
        <label>Node API token
          <input id="apiToken" type="password" autocomplete="off" placeholder="Bearer token value">
        </label>
        <label>Target country code
          <input id="country" value="US" maxlength="2" autocapitalize="characters" placeholder="US">
        </label>
      </div>
      <div class="actions">
        <button id="mcpButton">Check BrowserOS MCP</button>
        <button id="proxyButton">Test proxy + egress</button>
        <button id="readyButton" class="secondary">Check ready</button>
        <button id="countriesButton" class="secondary">Load countries</button>
      </div>
      <p id="status" class="hint">Ready.</p>
    </section>
    <section class="card">
      <div id="output" aria-live="polite">No diagnostic request yet.</div>
    </section>
  </main>
  <script>
    (() => {
      const token = document.querySelector('#apiToken');
      const country = document.querySelector('#country');
      const status = document.querySelector('#status');
      const output = document.querySelector('#output');
      const buttons = [...document.querySelectorAll('button')];

      function authHeaders() {
        const value = token.value.trim();
        return value ? { Authorization: 'Bearer ' + value, Accept: 'application/json' } : { Accept: 'application/json' };
      }

      async function request(label, path) {
        buttons.forEach((button) => { button.disabled = true; });
        status.textContent = label + '...';
        try {
          const response = await fetch(path, { headers: authHeaders(), cache: 'no-store' });
          const text = await response.text();
          let payload;
          try { payload = JSON.parse(text); } catch { payload = text; }
          output.textContent = JSON.stringify({ httpStatus: response.status, payload }, null, 2);
          status.textContent = response.ok ? label + ' succeeded.' : label + ' failed.';
        } catch (error) {
          output.textContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
          status.textContent = label + ' failed.';
        } finally {
          buttons.forEach((button) => { button.disabled = false; });
        }
      }

      document.querySelector('#mcpButton').addEventListener('click', () => request('BrowserOS MCP check', '/mcp-status'));
      document.querySelector('#proxyButton').addEventListener('click', () => {
        const code = country.value.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) {
          status.textContent = 'Enter a two-letter target country code.';
          return;
        }
        request('Proxy and egress test', '/proxy?country=' + encodeURIComponent(code));
      });
      document.querySelector('#readyButton').addEventListener('click', () => request('Readiness check', '/ready'));
      document.querySelector('#countriesButton').addEventListener('click', () => request('Country list', '/countries'));
    })();
  </script>
</body>
</html>`;
