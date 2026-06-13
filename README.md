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

Install from a local checkout:

```bash
npm install ../Navion
```

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
