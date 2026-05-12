import http from "node:http";
import { handleProxy } from "./src/proxy.js";
import { NAVION_CORE_CONFIG } from "./src/server/config/navion.config.js";
import { getNavionCoreRuntime } from "./src/server/index.js";

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url, `http://${host}`);
  const appBase = NAVION_CORE_CONFIG.appOrigin;

  if (url.pathname === "/api/fetch") return handleProxy(req, res, url);

  if (url.pathname === "/api/navion-status") {
    const runtime = getNavionCoreRuntime();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      name: runtime.name,
      layer: runtime.layer,
      version: runtime.version,
      runtime: process.version,
      status: "ok",
      prefix: runtime.prefix,
      apiEndpoint: runtime.apiEndpoint,
      mode: "core-backend",
    }));
    return;
  }

  if (url.pathname === "/generate_204" || url.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/index.html") {
    res.writeHead(302, { Location: `${appBase}/` });
    res.end();
    return;
  }

  if (url.pathname.startsWith("/nv/") || url.pathname === "/nv") {
    const redirectTarget = new URL(url.pathname + url.search + url.hash, appBase).href;
    res.writeHead(307, { Location: redirectTarget, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({
    error: "Navion core route not found",
    hint: `Use Navion-App at ${appBase} or call ${NAVION_CORE_CONFIG.apiEndpoint}?url=<encoded-url>.`,
  }));
});

const PORT = NAVION_CORE_CONFIG.port;
const HOST = NAVION_CORE_CONFIG.bindHost;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Navion Core - Backend Engine');
  console.log('  No UI routes, API only');
  console.log('═'.repeat(60));
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  API: ${NAVION_CORE_CONFIG.apiEndpoint}`);
  console.log('  Status: /api/navion-status');
  console.log('═'.repeat(60));
  console.log('  Ready as Navion-App backend core');
  console.log('═'.repeat(60));
  console.log('');
});

function shutdown() {
  console.log("Navion core shutdown signal received. Closing server...");
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
