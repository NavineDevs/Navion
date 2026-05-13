import http from "node:http";
import { handleProxy } from "../proxy.js";
import { NAVION_CORE_CONFIG } from "./config/navion.config.js";

export function createNavionCoreServer(options = {}) {
  const config = {
    ...NAVION_CORE_CONFIG,
    ...options,
  };

  return http.createServer(async (req, res) => {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const appBase = config.appOrigin;

    if (url.pathname === config.apiEndpoint) return handleProxy(req, res, url);

    if (url.pathname === "/api/navion-status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        name: "Navion",
        layer: "core",
        version: "4.0.0",
        runtime: process.version,
        status: "ok",
        prefix: config.prefix,
        apiEndpoint: config.apiEndpoint,
        mode: "core-backend",
      }));
      return;
    }

    if (url.pathname === "/generate_204") {
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": "0",
      });
      res.end("");
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/x-icon",
        "Content-Length": "0",
      });
      res.end("");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/index.html") {
      res.writeHead(302, { Location: `${appBase}/` });
      res.end();
      return;
    }

    if (url.pathname.startsWith(config.prefix) || url.pathname === config.prefix.slice(0, -1)) {
      const redirectTarget = new URL(url.pathname + url.search + url.hash, appBase).href;
      res.writeHead(307, { Location: redirectTarget, "Cache-Control": "no-store" });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      error: "Navion core route not found",
      hint: `Use Navion-App at ${appBase} or call ${config.apiEndpoint}?url=<encoded-url>.`,
    }));
  });
}
