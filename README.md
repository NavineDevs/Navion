# Navion (Core)

Custom zero-dependency proxy engine for NAVION/NV.

## What this project is

`Navion` is the backend proxy core only:
- Stream-based upstream fetch tunnel (`/api/fetch`)
- URL/CSS/HTML rewriting engine
- Cookie jar/session persistence for proxied domains
- No browser shell, no UI pages, no `/nv/*` gateway routes

## File layout (UV/Rammerhead-style split)

```txt
Navion/
  server.js
  src/
    proxy.js
    rewriters/
    server/
      index.js
      proxy.js
      config/
        navion.config.js
        routes.js
      pipeline/
        hooks.js
      rewriters/
        html.js
        css.js
        js.js
        url.js
```

## UV/Rammerhead-style internals now included

- Config-driven core runtime (`src/server/config/navion.config.js`)
- Hook/pipeline extension points (`beforeRequest`, `afterResponse`, `onError`)
- Server/runtime metadata endpoint (`/api/navion-status`)
- Graceful shutdown hooks for SIGINT/SIGTERM

## Requirements

- Node.js `18+`

## Run

```bash
npm start
```

Core server default:
- `http://localhost:8080`

## Core routes

- `/api/fetch?url=<encoded-url>` - proxy endpoint
- `/api/navion-status` - core status/metadata
- `/generate_204` - probe route

All UI/shell routes now live in `Navion-App`.

## Use as an npm dependency

Install from npm after publishing:

```bash
npm install navion
```

Install from a local checkout (used by Navion-App development):

```bash
npm install ../Navion
```

Set `NAVION_USE_LOCAL_CORE=1` in Navion-App to force the local link when both repos are checked out side by side.

Import the core proxy API:

```js
import { createNavionCoreServer, handleProxy, encode, decode } from "navion";

const server = createNavionCoreServer({
  port: 8080,
  appOrigin: "http://localhost:8090"
});

server.listen(8080, "0.0.0.0");
```

Import focused modules:

```js
import { handleProxy } from "navion/proxy";
import { rewriteHtml } from "navion/rewriters/html";
import { rewriteUrl } from "navion/rewriters/url";
```

Run the core directly:

```bash
npx navion-core
```

## Built-in DNS-over-HTTPS (no external dependency)

Navion resolves every upstream hostname through built-in DNS-over-HTTPS (DoH) using only Node core modules. This bypasses ISP DNS-based blocking of adult and other filtered sites without any external proxy, VPN, or npm package. Results are cached per host with TTL, and Navion falls back to system DNS when DoH is unavailable.

DoH is enabled by default. Environment variables:

- `NAVION_DOH=0` - disable DoH and use system DNS only
- `NAVION_DOH_ENDPOINTS` - comma-separated DoH JSON endpoints (default: Cloudflare, Google, Quad9)
- `NAVION_DOH_TIMEOUT` - per-request timeout in ms (default: `4000`)

Check `/api/navion-status` for `dns.doh` after startup.

## Adult sites and blocked hosts (no external dependency)

Navion reaches adult sites and other DNS-filtered hosts on its own, with no VPN, Tor, or external proxy required. When a direct connection fails on a known-blocked host, Navion re-resolves the host over its built-in encrypted DNS (DoH) and retries the connection directly against every resolved IPv4 and IPv6 address before reporting an error. This keeps the whole stack zero-dependency.

An optional local proxy is still supported for networks that also block by SNI or raw IP, but it is never required for normal operation:

- `NAVION_UPSTREAM_PROXY` - optional SOCKS5 or HTTP proxy URL (e.g. `socks5://127.0.0.1:1080`)
- `NAVION_UPSTREAM_PROXY_HOSTS` - comma-separated host rules (default: pornhub, hanime, and related adult CDNs)
- `NAVION_UPSTREAM_PROXY_ALL=1` - route all upstream fetches through the proxy
- `NAVION_UPSTREAM_PROXY_AUTO=1` - probe common local proxy ports for blocked hosts

Check `/api/navion-status` for `dns.doh` and `upstreamProxy.enabled` after startup.

## Branding / Credits

- Company: **Navine**
- Lead Dev: **HitBoyXx23**
- Core repo: https://github.com/NavineDevs/Navion
- App repo: https://github.com/NavineDevs/Navion-App

## Build your own "dependency" (NAVION way)

If you want a feature but do not want external packages, build small internal modules:

1. Define one exact problem (example: cookie parsing, HTML token scanning, header transforms).
2. Create a local module in `src/` (example: `src/internal/cookies.js`) with a tiny API.
3. Write plain Node/browser code only (no npm dependency).
4. Keep it replaceable: one file, pure functions, input/output tests with real proxy traffic.
5. Version your internal module through `package.json`, changelog notes, and reuse it across core/app.

Example pattern:

```js
export function applyHeaderPolicy(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === "x-frame-options" || key === "content-security-policy") continue;
    out[k] = v;
  }
  return out;
}
```

Then import it in proxy code and evolve it as your own NAVION dependency.
