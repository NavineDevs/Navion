import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleProxy } from "../proxy.js";
import { decode, encode } from "../rewriters/url.js";
import { NAVION_APP_SERVER_DEFAULTS } from "./config/app-server.config.js";

const MIMES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function mergeConfig(options = {}) {
  const defaults = NAVION_APP_SERVER_DEFAULTS;
  const localAssetPaths = options.localAssetPaths instanceof Set
    ? options.localAssetPaths
    : new Set([...defaults.localAssetPaths, ...(options.localAssetPaths || [])]);
  return {
    ...defaults,
    ...options,
    localAssetPaths,
  };
}

function parseCookies(headerValue) {
  const out = {};
  if (!headerValue) return out;
  const parts = headerValue.split(";");
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i].trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq === -1) continue;
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}

function createRouteHelpers(config) {
  const NAVION_PREFIX = config.prefix;
  const DEFAULT_DUCK_AI_ORIGIN = config.defaultDuckAiOrigin;
  const DEFAULT_DUCKDUCKGO_ORIGIN = config.defaultDuckduckgoOrigin;
  let lastChallengeBase = null;
  let lastChallengeBaseAt = 0;

  function decodeNavionValue(value) {
    if (!value) return null;
    try {
      const decoded = decode(value);
      return /^https?:\/\//i.test(decoded) ? decoded : null;
    } catch {
      return /^https?:\/\//i.test(value) ? value : null;
    }
  }

  function resolveBaseFromPath(pathname) {
    if (!pathname || !pathname.startsWith(NAVION_PREFIX)) return null;
    try {
      const target = resolveTargetFromNavionPath(pathname, "");
      if (target) return new URL(target).origin + "/";
    } catch {}
    let raw = "";
    try {
      raw = decodeURIComponent(pathname.slice(NAVION_PREFIX.length).split("/")[0]);
    } catch {
      return null;
    }
    if (!raw) return null;
    return decodeNavionValue(raw);
  }

  function resolveTargetFromNavionPath(pathname, search) {
    if (!pathname || !pathname.startsWith(NAVION_PREFIX)) return null;
    const rawPath = pathname.slice(NAVION_PREFIX.length);
    if (!rawPath) return null;
    const slash = rawPath.indexOf("/");
    let rawToken = slash === -1 ? rawPath : rawPath.slice(0, slash);
    let suffix = slash === -1 ? "" : rawPath.slice(slash);
    if (!suffix) {
      const markers = ["dist/", "_next/", "country.json", "duckchat/", "static/"];
      for (const marker of markers) {
        const index = rawPath.indexOf(marker);
        if (index > 0) {
          rawToken = rawPath.slice(0, index);
          suffix = `/${rawPath.slice(index)}`;
          break;
        }
      }
    }
    const token = decodeURIComponent(rawToken);
    const base = decodeNavionValue(token);
    if (!base) return null;
    const target = new URL(base);
    if (suffix) {
      target.pathname = target.pathname.replace(/\/?$/, "") + decodeURI(suffix);
    }
    if (search) target.search = search;
    return target.href;
  }

  function resolveRelativeTargetFromNavionPath(pathname, search, baseTarget) {
    if (!pathname || !pathname.startsWith(NAVION_PREFIX) || !baseTarget) return null;
    const rawPath = pathname.slice(NAVION_PREFIX.length);
    if (!rawPath) return null;
    return new URL(rawPath + (search || ""), baseTarget).href;
  }

  function isDroppedTelemetryUrl(url) {
    const host = String(url.hostname || "").toLowerCase();
    const pathname = String(url.pathname || "").toLowerCase();
    return (
      host === "improving.duckduckgo.com" ||
      host.endsWith(".improving.duckduckgo.com") ||
      pathname.indexOf("/t/static_fcp") === 0 ||
      pathname.indexOf("/t/page_home_searchbox_submit") === 0
    );
  }

  function resolveKnownAssetTarget(pathname, search, baseTarget) {
    const pathValue = String(pathname || "");
    if (
      baseTarget &&
      (
        pathValue.startsWith("/_next/") ||
        pathValue.startsWith("/assets/") ||
        pathValue.startsWith("/static/") ||
        pathValue.startsWith("/cdn-cgi/") ||
        pathValue.startsWith("/content/") ||
        pathValue.startsWith("/wp-content/") ||
        pathValue.startsWith("/wp-includes/") ||
        /\.(?:js|mjs|css|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|m3u8|mpd|ts|m4s|m4v|mov|m4a|mp3|aac|vtt)(?:$|\?)/i.test(pathValue)
      )
    ) {
      try {
        return new URL(pathValue + (search || ""), baseTarget).href;
      } catch {}
    }
    if (
      pathValue.startsWith("/dist/duckai-dist/") ||
      pathValue.startsWith("/dist/locale/") ||
      pathValue === "/country.json" ||
      pathValue.startsWith("/duckchat/")
    ) {
      return new URL(pathValue + (search || ""), DEFAULT_DUCK_AI_ORIGIN).href;
    }
    return null;
  }

  function decodeNestedUrl(value) {
    if (!value) return null;
    let out = String(value).replace(/(?:&amp;|&)rut=[^&]+$/i, "").replace(/&amp;/g, "&");
    for (let i = 0; i < 4; i++) {
      try {
        const next = decodeURIComponent(out);
        if (next === out) break;
        out = next.replace(/(?:&amp;|&)rut=[^&]+$/i, "").replace(/&amp;/g, "&");
      } catch {
        break;
      }
    }
    return /^https?:\/\//i.test(out) ? out : null;
  }

  function normalizeProxyTarget(target) {
    try {
      const targetUrl = new URL(target);
      const host = targetUrl.hostname.toLowerCase();
      if (host === "m.youtube.com") {
        targetUrl.hostname = "www.youtube.com";
        return targetUrl.href;
      }
      if (host === "pornhub.com") {
        targetUrl.hostname = "www.pornhub.com";
        return targetUrl.href;
      }
      if (host === "hanime.tv" || host === "www.hanime.tv") {
        targetUrl.hostname = "hstream.moe";
        return targetUrl.href;
      }
      if (
        (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "html.duckduckgo.com") &&
        (targetUrl.pathname === "/ai" || targetUrl.pathname.startsWith("/ai/") || targetUrl.searchParams.get("duckai") === "1" || targetUrl.searchParams.get("ia") === "chat" || targetUrl.searchParams.get("iax") === "chat")
      ) {
        return DEFAULT_DUCK_AI_ORIGIN;
      }
      if (
        (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "html.duckduckgo.com") &&
        targetUrl.pathname === "/l/"
      ) {
        const destination = decodeNestedUrl(targetUrl.searchParams.get("uddg"));
        if (destination) return destination;
      }
      if (
        (host === "duckduckgo.com" || host === "www.duckduckgo.com") &&
        (targetUrl.pathname === "/" || targetUrl.pathname === "") &&
        targetUrl.searchParams.get("q")
      ) {
        const htmlUrl = new URL("https://html.duckduckgo.com/html/");
        const keep = ["q", "kl", "kp", "k1", "kz", "df"];
        for (const name of keep) {
          const value = targetUrl.searchParams.get(name);
          if (value !== null) htmlUrl.searchParams.set(name, value);
        }
        return htmlUrl.href;
      }
    } catch {}
    return target;
  }

  function isYouTubePagePath(pathname) {
    const path = String(pathname || "");
    if (path.startsWith("/youtubei/") || path.startsWith("/s/")) return true;
    if (path === "/watch") return true;
    if (path.startsWith("/watch/")) return false;
    if (path === "/shorts" || path.startsWith("/shorts/")) return true;
    if (path === "/embed" || path.startsWith("/embed/")) return true;
    if (path === "/results" || path.startsWith("/results/")) return true;
    if (path.startsWith("/channel/") || path.startsWith("/c/") || path.startsWith("/user/")) return true;
    if (path.startsWith("/playlist")) return true;
    if (path.startsWith("/feed/")) return true;
    if (path.startsWith("/@")) return true;
    if (path === "/live_chat" || path.startsWith("/live_chat/")) return true;
    return false;
  }

  function resolveDefaultBaseTarget(pathname) {
    if (isYouTubePagePath(pathname)) return "https://www.youtube.com/";
    return null;
  }

  function resolveBaseContext(req) {
    let baseTarget = null;
    let fromProxyReferer = false;
    const origin = `http://${req.headers.host}`;
    const referer = req.headers.referer || "";
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.origin === origin) {
          baseTarget = resolveBaseFromPath(refUrl.pathname);
          fromProxyReferer = refUrl.pathname.startsWith(NAVION_PREFIX);
        }
      } catch {}
    }

    if (!baseTarget) {
      try {
        const cookies = parseCookies(req.headers.cookie || "");
        if (cookies.nv_base) {
          baseTarget = decodeNavionValue(cookies.nv_base);
        }
        if (!baseTarget && cookies.nv_origin) {
          const decodedOrigin = decodeNavionValue(cookies.nv_origin);
          if (/^https?:\/\//i.test(decodedOrigin)) baseTarget = decodedOrigin + "/";
        }
      } catch {}
    }

    if (!baseTarget && String(req.url || "").startsWith("/cdn-cgi/") && lastChallengeBase && Date.now() - lastChallengeBaseAt < 120000) {
      baseTarget = lastChallengeBase;
      fromProxyReferer = true;
    }

    return { baseTarget, fromProxyReferer };
  }

  function rememberChallengeTarget(target) {
    try {
      const targetUrl = new URL(target);
      if (targetUrl.pathname.startsWith("/cdn-cgi/") || targetUrl.hostname.toLowerCase().includes("nhplayer")) {
        lastChallengeBase = targetUrl.origin + "/";
        lastChallengeBaseAt = Date.now();
      }
    } catch {}
  }

  function setBaseCookies(res, target) {
    try {
      const targetOrigin = new URL(target).origin;
      const stableBase = encode(targetOrigin + "/");
      const stableOrigin = encode(targetOrigin);
      res.setHeader("Set-Cookie", [
        `nv_base=${stableBase}; Path=/; SameSite=Lax; Max-Age=2592000`,
        `nv_origin=${stableOrigin}; Path=/; SameSite=Lax; Max-Age=2592000`,
      ]);
    } catch {}
  }

  return {
    NAVION_PREFIX,
    decodeNavionValue,
    resolveBaseFromPath,
    resolveTargetFromNavionPath,
    resolveRelativeTargetFromNavionPath,
    isDroppedTelemetryUrl,
    resolveKnownAssetTarget,
    normalizeProxyTarget,
    isYouTubePagePath,
    resolveDefaultBaseTarget,
    resolveBaseContext,
    rememberChallengeTarget,
    setBaseCookies,
  };
}

function createStaticHelpers(staticDir) {
  function serveFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIMES[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    if (path.basename(filePath) === "nv.sw.js") res.setHeader("Service-Worker-Allowed", "/");
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Not found");
    });
    stream.pipe(res);
  }

  function findStaticFile(reqPath) {
    const safePath = reqPath === "/" ? "/index.html" : reqPath;
    const appFile = path.join(staticDir, safePath);
    if (appFile.startsWith(staticDir + path.sep) && fs.existsSync(appFile) && fs.statSync(appFile).isFile()) return appFile;
    return null;
  }

  return { serveFile, findStaticFile };
}

export function createServer(options = {}) {
  const config = mergeConfig(options);
  if (!config.staticDir) {
    throw new Error("createServer requires staticDir");
  }
  const staticDir = path.resolve(config.staticDir);
  const routes = createRouteHelpers(config);
  const staticHelpers = createStaticHelpers(staticDir);
  const {
    NAVION_PREFIX,
    resolveTargetFromNavionPath,
    resolveRelativeTargetFromNavionPath,
    isDroppedTelemetryUrl,
    resolveKnownAssetTarget,
    normalizeProxyTarget,
    isYouTubePagePath,
    resolveDefaultBaseTarget,
    resolveBaseContext,
    rememberChallengeTarget,
    setBaseCookies,
  } = routes;
  const { serveFile, findStaticFile } = staticHelpers;
  const localAssetPaths = config.localAssetPaths;
  const apiEndpoint = config.apiEndpoint;
  const statusEndpoint = config.statusEndpoint;

  function proxyTarget(req, res, target) {
    const proxyUrl = new URL(apiEndpoint, `http://${req.headers.host}`);
    proxyUrl.searchParams.set("url", encode(normalizeProxyTarget(target)));
    return handleProxy(req, res, proxyUrl);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === apiEndpoint) {
      try {
        const encodedTarget = url.searchParams.get("url");
        if (encodedTarget) rememberChallengeTarget(normalizeProxyTarget(decode(encodedTarget)));
      } catch {}
      return handleProxy(req, res, url);
    }

    if (url.pathname === statusEndpoint) {
      const runtime = typeof config.getRuntime === "function" ? config.getRuntime() : null;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(runtime || {
        name: "Navion",
        layer: "app",
        version: "1.0.1",
        runtime: process.version,
        status: "ok",
      }));
      return;
    }

    if (url.pathname === "/generate_204") {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }

    if (isYouTubePagePath(url.pathname) && !url.pathname.startsWith(NAVION_PREFIX) && !localAssetPaths.has(url.pathname)) {
      const ytBase = resolveDefaultBaseTarget(url.pathname);
      if (ytBase) {
        try {
          const target = new URL(url.pathname + url.search + url.hash, ytBase).href;
          setBaseCookies(res, target);
          const accept = String(req.headers.accept || "").toLowerCase();
          const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
          if (dest === "document" || dest === "iframe" || accept.includes("text/html")) {
            res.writeHead(302, {
              Location: NAVION_PREFIX + encode(target),
              "Cache-Control": "no-store",
            });
            res.end();
            return;
          }
          return proxyTarget(req, res, target);
        } catch {}
      }
    }

    if (url.pathname === "/favicon.ico") {
      const iconPath = path.join(staticDir, "logo.png");
      if (fs.existsSync(iconPath)) return serveFile(res, iconPath);
      const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1a1f36"/><path d="M16 46V18h8l16 18V18h8v28h-8L24 28v18z" fill="#b8c4ff"/></svg>`;
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(icon),
      });
      res.end(icon);
      return;
    }

    const baseContext = resolveBaseContext(req);
    const isShellAssetRequest = url.pathname === "/app" || url.pathname === "/index.html";

    if (url.pathname === "/app" && !(baseContext.baseTarget && baseContext.fromProxyReferer)) {
      return serveFile(res, path.join(staticDir, "index.html"));
    }

    if (url.pathname === "/nav/home") return serveFile(res, path.join(staticDir, "nav.home.html"));
    if (url.pathname === "/nav/error") return serveFile(res, path.join(staticDir, "nav.error.html"));

    if (
      url.pathname === "/nv.sw.js" ||
      url.pathname === "/nv.client.js" ||
      url.pathname === "/nv.register.js" ||
      url.pathname === "/logo.png"
    ) {
      const localAsset = findStaticFile(url.pathname);
      if (localAsset) return serveFile(res, localAsset);
    }

    const knownAssetTarget = resolveKnownAssetTarget(url.pathname, url.search, baseContext.baseTarget);
    if (knownAssetTarget) {
      rememberChallengeTarget(knownAssetTarget);
      return proxyTarget(req, res, knownAssetTarget);
    }

    if (url.pathname.startsWith(NAVION_PREFIX)) {
      const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
      const accept = String(req.headers.accept || "").toLowerCase();
      if (dest === "document" && accept.includes("text/html")) {
        const referer = String(req.headers.referer || "");
        const fromShell = referer.includes("/app") || referer.endsWith("/") || referer.includes("/index.html");
        if (!fromShell) {
          res.writeHead(302, {
            Location: `/app?open=${encodeURIComponent(url.pathname + url.search + url.hash)}`,
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
      }
      if (dest === "iframe" && accept.includes("text/html")) {
        // Always proxy iframe navigations directly.
      }
      const { baseTarget } = baseContext;
      const rawNavionPath = url.pathname.slice(NAVION_PREFIX.length);
      let target = null;
      try { target = resolveTargetFromNavionPath(url.pathname, url.search); } catch {}
      if (!target) {
        try { target = resolveRelativeTargetFromNavionPath(url.pathname, url.search, baseTarget); } catch {}
      }
      if (!target) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      setBaseCookies(res, target);
      rememberChallengeTarget(target);
      try {
        if (isDroppedTelemetryUrl(new URL(target))) {
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
      } catch {}
      try {
        const accept = String(req.headers.accept || "").toLowerCase();
        const targetUrl = new URL(target);
        const suffix = targetUrl.pathname + targetUrl.search + targetUrl.hash;
        if (!rawNavionPath.includes("/") && suffix !== "/" && accept.includes("text/html")) {
          res.writeHead(302, {
            Location: NAVION_PREFIX + encode(targetUrl.origin + "/") + suffix,
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
      } catch {}
      return proxyTarget(req, res, target);
    }

    if (url.pathname === NAVION_PREFIX.slice(0, -1)) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }

    let { baseTarget, fromProxyReferer } = baseContext;

    if (!baseTarget) {
      baseTarget = resolveDefaultBaseTarget(url.pathname);
    }

    const isRootShellPath = url.pathname === "/" || isShellAssetRequest;

    if (baseTarget && fromProxyReferer && isRootShellPath) {
      try {
        const target = new URL(url.pathname + url.search + url.hash, baseTarget).href;
        const accept = String(req.headers.accept || "").toLowerCase();
        if (req.headers["sec-fetch-dest"] === "document" || accept.includes("text/html")) {
          res.writeHead(302, { Location: NAVION_PREFIX + encode(target) });
          res.end();
          return;
        }
        return proxyTarget(req, res, target);
      } catch {}
    }

    if (isRootShellPath) {
      return serveFile(res, path.join(staticDir, "index.html"));
    }

    if (
      baseTarget &&
      isYouTubePagePath(url.pathname) &&
      !url.pathname.startsWith(NAVION_PREFIX) &&
      !localAssetPaths.has(url.pathname)
    ) {
      const accept = String(req.headers.accept || "").toLowerCase();
      const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
      if (dest === "document" || dest === "iframe" || accept.includes("text/html")) {
        try {
          const target = new URL(url.pathname + url.search + url.hash, baseTarget).href;
          setBaseCookies(res, target);
          res.writeHead(302, {
            Location: NAVION_PREFIX + encode(target),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        } catch {}
      }
    }

    if (baseTarget && !localAssetPaths.has(url.pathname)) {
      try {
        const target = new URL(url.pathname + url.search + url.hash, baseTarget).href;
        return proxyTarget(req, res, target);
      } catch {}
    }

    const filePath = findStaticFile(url.pathname);
    if (filePath) return serveFile(res, filePath);

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
}

export function startServer(options = {}) {
  const config = mergeConfig(options);
  const port = config.port;
  const host = config.bindHost;
  const server = createServer(config);
  server.listen(port, host, () => {
    if (typeof config.onListen === "function") {
      config.onListen({ port, host, server });
      return;
    }
    console.log("");
    console.log("=".repeat(60));
    console.log("  Navion App Server");
    console.log("=".repeat(60));
    console.log(`  Server: http://localhost:${port}`);
    console.log("=".repeat(60));
    console.log("");
  });
  return server;
}
