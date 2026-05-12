import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { decode, encode } from "./rewriters/url.js";
import { rewriteHtml } from "./rewriters/html.js";
import { rewriteJs } from "./rewriters/js.js";
import { rewriteCss } from "./rewriters/css.js";
import { NAVION_CORE_CONFIG } from "./server/config/navion.config.js";
import { runNavionHooks } from "./server/pipeline/hooks.js";

const PREFIX = NAVION_CORE_CONFIG.prefix;
const MAX_REDIRECTS = NAVION_CORE_CONFIG.fetch.maxRedirects;

const CACHE = new Map();
let cacheBytes = 0;
const CACHE_MAX_BYTES = NAVION_CORE_CONFIG.cache.maxBytes;
const CACHE_TTL = NAVION_CORE_CONFIG.cache.ttlMs;
const CACHE_ENTRY_MAX = NAVION_CORE_CONFIG.cache.entryMaxBytes;
const CACHEABLE_CT = /^(image\/|font\/|text\/css|application\/javascript|text\/javascript)/;
const SESSION_JARS = new Map();
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const SESSION_STORE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".navion-sessions.json");
let sessionStoreDirty = false;
let sessionStoreFlushTimer = null;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cacheBytes -= e.body.length; CACHE.delete(key); return null; }
  return e;
}

function cacheSet(key, status, headers, body) {
  if (body.length > CACHE_ENTRY_MAX) return;
  if (CACHE.has(key)) { cacheBytes -= CACHE.get(key).body.length; CACHE.delete(key); }
  while (cacheBytes + body.length > CACHE_MAX_BYTES && CACHE.size) {
    const oldest = CACHE.keys().next().value;
    cacheBytes -= CACHE.get(oldest).body.length;
    CACHE.delete(oldest);
  }
  cacheBytes += body.length;
  CACHE.set(key, { status, headers, body, exp: Date.now() + CACHE_TTL });
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, scheduling: "fifo" });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 256,
  rejectUnauthorized: false,
  scheduling: "fifo",
  ALPNProtocols: ["http/1.1"],
});

const DROP_REQ = new Set([
  "host", "origin", "connection", "keep-alive", "te", "trailer",
  "upgrade", "proxy-authorization", "transfer-encoding", "accept-encoding",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "cookie",
]);

const DROP_RES = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "content-encoding", "content-security-policy",
  "content-security-policy-report-only", "x-frame-options",
  "strict-transport-security",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "report-to",
]);

const BASE_HEADERS = { ...NAVION_CORE_CONFIG.baseHeaders };

function isNonCriticalFailure(req, targetUrl) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (
      host === "improving.duckduckgo.com" ||
      host === "googleads.g.doubleclick.net"
    ) {
      return true;
    }
    if (/\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|json)(?:$|\?)/i.test(pathname)) {
      return true;
    }
  } catch {}
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (dest) return dest !== "document" && dest !== "iframe" && dest !== "frame";
  const accept = String(req.headers.accept || "").toLowerCase();
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) return false;
  return (
    accept.includes("javascript") ||
    accept.includes("text/css") ||
    accept.includes("image/") ||
    accept.includes("font/") ||
    accept.includes("application/json") ||
    accept.includes("*/*")
  );
}

function isNonCriticalYouTubeApiPath(pathname) {
  return (
    pathname.startsWith("/youtubei/v1/log_event") ||
    pathname.startsWith("/youtubei/v1/feedback")
  );
}

function isNonCriticalYouTubeTelemetryPath(pathname) {
  return (
    pathname.startsWith("/api/stats/") ||
    pathname.startsWith("/ptracking")
  );
}

function isYouTubeLikeHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host.endsWith(".youtube.com")
  );
}

function shouldBypassJsRewrite(resourceUrl) {
  try {
    const u = new URL(resourceUrl);
    const host = u.hostname.toLowerCase();
    const isYouTubeFamily =
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "ytimg.com" ||
      host.endsWith(".ytimg.com");

    const isGoogleIdentityFamily =
      host === "accounts.google.com" ||
      host.endsWith(".accounts.google.com") ||
      host === "gstatic.com" ||
      host.endsWith(".gstatic.com") ||
      host === "googleapis.com" ||
      host.endsWith(".googleapis.com");

    if (isYouTubeFamily) return true;
    if (isGoogleIdentityFamily) return true;
    return false;
  } catch {
    return false;
  }
}

function isRecoverableSocketError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "ERR_INVALID_PROTOCOL"
  ) {
    return true;
  }
  const msg = String(err.message || "");
  return (
    msg.includes("ECONN") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ERR_INVALID_") ||
    msg.toLowerCase().includes("timed out")
  );
}

function rawFetch(targetUrl, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: NAVION_CORE_CONFIG.fetch.timeoutMs,
    }, (res) => {
      const { statusCode: status, headers } = res;
      const location = headers["location"];

      if (status >= 300 && status < 400 && location && redirectCount < MAX_REDIRECTS) {
        res.resume();
        resolve(rawFetch(new URL(location, targetUrl).href, options, redirectCount + 1));
        return;
      }

      resolve({ status, headers, body: res, url: targetUrl });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

async function navionFetchWithRetry(targetUrl, options, retries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await rawFetch(targetUrl, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRecoverableSocketError(error)) break;
    }
  }
  throw lastError || new Error("Fetch failed");
}

function decompressStream(stream, encoding) {
  const enc = (encoding || "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return stream.pipe(zlib.createGunzip());
  if (enc === "deflate") return stream.pipe(zlib.createInflate());
  if (enc === "br") return stream.pipe(zlib.createBrotliDecompress());
  return stream;
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function getReqBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseCookieHeader(headerValue) {
  const out = {};
  if (!headerValue) return out;
  const parts = String(headerValue).split(";");
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function newNavionSessionId() {
  return `nv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function navionSessionCookieValue(sessionId) {
  return `nv_sid=${sessionId}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${SESSION_COOKIE_MAX_AGE}`;
}

function getSessionJar(sid) {
  let jar = SESSION_JARS.get(sid);
  if (!jar) {
    jar = new Map();
    SESSION_JARS.set(sid, jar);
  }
  return jar;
}

function parseSetCookiePair(line) {
  if (!line) return null;
  const parts = String(line).split(";").map((p) => p.trim());
  const first = parts[0];
  const i = first.indexOf("=");
  if (i <= 0) return null;
  const name = first.slice(0, i).trim();
  const value = first.slice(i + 1).trim();
  if (!name) return null;
  let domain = "";
  let expired = false;
  for (let idx = 1; idx < parts.length; idx++) {
    const part = parts[idx];
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (key === "domain") {
      domain = value.replace(/^\./, "").toLowerCase();
      continue;
    }
    if (key === "max-age") {
      const maxAge = Number(value);
      if (!Number.isNaN(maxAge) && maxAge <= 0) expired = true;
      continue;
    }
    if (key === "expires") {
      const expTime = Date.parse(value);
      if (!Number.isNaN(expTime) && expTime <= Date.now()) expired = true;
      continue;
    }
  }
  return { name, value, domain, expired };
}

function scheduleSessionStoreFlush() {
  sessionStoreDirty = true;
  if (sessionStoreFlushTimer) return;
  sessionStoreFlushTimer = setTimeout(() => {
    sessionStoreFlushTimer = null;
    if (!sessionStoreDirty) return;
    sessionStoreDirty = false;
    flushSessionStore();
  }, 350);
}

function serializeSessionJars() {
  const sessions = {};
  for (const [sid, jar] of SESSION_JARS.entries()) {
    const sessionObj = {};
    for (const [domain, hostJar] of jar.entries()) {
      const cookies = {};
      for (const [name, value] of hostJar.entries()) cookies[name] = value;
      if (Object.keys(cookies).length) sessionObj[domain] = cookies;
    }
    if (Object.keys(sessionObj).length) sessions[sid] = sessionObj;
  }
  return { version: 1, sessions };
}

function hydrateSessionJars(payload) {
  if (!payload || typeof payload !== "object") return;
  const sessions = payload.sessions;
  if (!sessions || typeof sessions !== "object") return;
  for (const [sid, domains] of Object.entries(sessions)) {
    if (!sid || !domains || typeof domains !== "object") continue;
    const sessionJar = new Map();
    for (const [domain, cookieObj] of Object.entries(domains)) {
      if (!domain || !cookieObj || typeof cookieObj !== "object") continue;
      const hostJar = new Map();
      for (const [cookieName, cookieValue] of Object.entries(cookieObj)) {
        if (!cookieName) continue;
        hostJar.set(cookieName, String(cookieValue));
      }
      if (hostJar.size) sessionJar.set(domain.toLowerCase(), hostJar);
    }
    if (sessionJar.size) SESSION_JARS.set(sid, sessionJar);
  }
}

function flushSessionStore() {
  try {
    fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify(serializeSessionJars()), "utf8");
  } catch (error) {
    console.error("[NAVION] Failed to persist session store:", error.message);
  }
}

function loadSessionStore() {
  if (!fs.existsSync(SESSION_STORE_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSION_STORE_FILE, "utf8");
    if (!raw) return;
    hydrateSessionJars(JSON.parse(raw));
  } catch (error) {
    console.error("[NAVION] Failed to load session store:", error.message);
  }
}

function storeResponseCookies(sid, host, setCookieHeader) {
  if (!setCookieHeader) return;
  const jar = getSessionJar(sid);
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of list) {
    const pair = parseSetCookiePair(line);
    if (!pair) continue;
    const jarKey = (pair.domain || host).toLowerCase();
    let hostJar = jar.get(jarKey);
    if (!hostJar) {
      hostJar = new Map();
      jar.set(jarKey, hostJar);
    }
    if (pair.expired) hostJar.delete(pair.name);
    else hostJar.set(pair.name, pair.value);
    if (hostJar.size === 0) jar.delete(jarKey);
  }
  if (jar.size === 0) SESSION_JARS.delete(sid);
  scheduleSessionStoreFlush();
}

function buildUpstreamCookieHeader(sid, host) {
  const jar = SESSION_JARS.get(sid);
  if (!jar) return "";
  const hostLower = host.toLowerCase();

  const out = new Map();
  for (const [domain, hostJar] of jar.entries()) {
    if (!(hostLower === domain || hostLower.endsWith(`.${domain}`))) continue;
    for (const [k, v] of hostJar.entries()) out.set(k, v);
  }
  if (out.size === 0) return "";
  return Array.from(out.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

loadSessionStore();
process.on("beforeExit", flushSessionStore);
process.on("SIGINT", flushSessionStore);
process.on("SIGTERM", flushSessionStore);

function buildOutHeaders(resHeaders) {
  const out = {
    "cross-origin-resource-policy": "cross-origin",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "*",
    "timing-allow-origin": "*",
  };
  for (const [k, v] of Object.entries(resHeaders)) {
    if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
  }
  delete out["set-cookie"];
  return out;
}

function rewriteLocationHeader(locationValue, baseUrl) {
  if (!locationValue) return locationValue;
  try {
    const absolute = new URL(locationValue, baseUrl).href;
    const protocol = new URL(absolute).protocol;
    if (protocol !== "http:" && protocol !== "https:") return locationValue;
    return `${PREFIX}${encode(absolute)}`;
  } catch {
    return locationValue;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildErrorHtml(status, title, message, targetUrl) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message || "Unknown error");
  const retryHref = targetUrl ? `/nv/${encode(targetUrl)}` : "/nav/home";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NAVION Error</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; font-family: Segoe UI, Arial, sans-serif; background: #0f1220; color: #d7defe; }
    .nv-wrap { min-height: 100%; display: grid; place-items: center; padding: 20px; }
    .nv-card { width: min(780px, 100%); background: #1a1f36; border: 1px solid #2b3358; border-radius: 14px; padding: 20px; }
    .nv-brand { font-weight: 700; color: #b8c4ff; letter-spacing: 1px; margin-bottom: 10px; }
    .nv-code { color: #8ea1ff; font-size: 13px; margin-bottom: 6px; }
    .nv-title { font-size: 26px; margin: 0 0 10px; }
    .nv-message { margin: 0 0 14px; line-height: 1.5; color: #c5cffb; }
    .nv-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .nv-btn { text-decoration: none; border: 1px solid #5664aa; background: #4b5cb8; color: #fff; border-radius: 8px; padding: 8px 12px; font-size: 14px; }
    .nv-btn-alt { background: #222a49; border-color: #3d4778; color: #d7defe; }
    .nv-meta { margin-top: 14px; font-size: 13px; color: #b8c4ff; line-height: 1.6; }
    .nv-meta a { color: #9db0ff; }
  </style>
</head>
<body>
  <div class="nv-wrap">
    <div class="nv-card">
      <div class="nv-brand">NAVION</div>
      <div class="nv-code">Status ${status}</div>
      <h1 class="nv-title">${safeTitle}</h1>
      <p class="nv-message">${safeMessage}</p>
      <div class="nv-actions">
        <a class="nv-btn" href="${retryHref}">Try again</a>
        <a class="nv-btn nv-btn-alt" href="/nav/home">Go to NAVION home</a>
      </div>
      <div class="nv-meta">
        Company: <strong>Navine</strong><br>
        Lead Dev: <strong>HitBoyXx23</strong><br>
        Core Repo: <a href="https://github.com/NavineDevs/Navion" target="_blank" rel="noopener noreferrer">github.com/NavineDevs/Navion</a><br>
        App Repo: <a href="https://github.com/NavineDevs/Navion-App" target="_blank" rel="noopener noreferrer">github.com/NavineDevs/Navion-App</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function errorResponse(res, status, title, message, targetUrl) {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  }
  res.end(buildErrorHtml(status, title, message, targetUrl));
}

export async function handleProxy(req, res, url) {
  await runNavionHooks("beforeRequest", { req, res, url });
  const encoded = url.searchParams.get("url");
  if (!encoded) {
    errorResponse(res, 400, "Missing URL", "No URL was provided to proxy.");
    return;
  }

  let targetUrl;
  try {
    targetUrl = decode(encoded);
    const { protocol } = new URL(targetUrl);
    if (protocol !== "http:" && protocol !== "https:") throw 0;
  } catch {
    errorResponse(res, 400, "Invalid URL", "The provided URL could not be decoded or is not a valid http/https address.");
    return;
  }

  const fwdHeaders = { ...BASE_HEADERS };
  const inCookies = parseCookieHeader(req.headers.cookie || "");
  const sessionId = inCookies.nv_sid || newNavionSessionId();
  const setSessionCookie = !inCookies.nv_sid;

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (DROP_REQ.has(lower)) continue;
    if (lower === "referer") {
      try {
        const ref = new URL(value);
        if (ref.pathname.startsWith(PREFIX)) {
          fwdHeaders["referer"] = decode(ref.pathname.slice(PREFIX.length).split("?")[0]);
        }
      } catch {}
      continue;
    }
    fwdHeaders[key] = value;
  }

  const target = new URL(targetUrl);
  const host = target.hostname.toLowerCase();
  const isGoogleVideo = host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  const isYouTubeHost = isYouTubeLikeHost(host);
  const isYouTubeApi = isYouTubeHost && target.pathname.startsWith("/youtubei/");
  const isYouTubeTelemetry = isYouTubeHost && isNonCriticalYouTubeTelemetryPath(target.pathname);
  const isYouTubeGenerate204 =
    target.pathname === "/generate_204" &&
    (isYouTubeHost || host === "ytimg.com" || host.endsWith(".ytimg.com"));
  const upstreamCookie = buildUpstreamCookieHeader(sessionId, host);
  if (upstreamCookie) fwdHeaders.cookie = upstreamCookie;
  if (isYouTubeGenerate204) {
    const quickHeaders = { "cache-control": "no-store" };
    if (setSessionCookie) quickHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(204, quickHeaders);
    res.end();
    return;
  }
  if (isYouTubeTelemetry) {
    const quietHeaders = { "cache-control": "no-store" };
    if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(204, quietHeaders);
    res.end();
    return;
  }

  if (isGoogleVideo) {
    let normalizedReferer = "https://www.youtube.com/";
    try {
      if (fwdHeaders.referer) {
        const refererUrl = new URL(fwdHeaders.referer);
        if (isYouTubeLikeHost(refererUrl.hostname)) normalizedReferer = refererUrl.href;
      }
    } catch {}
    fwdHeaders.referer = normalizedReferer;
    fwdHeaders.origin = new URL(normalizedReferer).origin;
    if (req.headers["sec-fetch-site"]) fwdHeaders["sec-fetch-site"] = req.headers["sec-fetch-site"];
    else fwdHeaders["sec-fetch-site"] = "cross-site";
    if (req.headers["sec-fetch-mode"]) fwdHeaders["sec-fetch-mode"] = req.headers["sec-fetch-mode"];
    else fwdHeaders["sec-fetch-mode"] = "no-cors";
    if (req.headers["sec-fetch-dest"]) fwdHeaders["sec-fetch-dest"] = req.headers["sec-fetch-dest"];
    else fwdHeaders["sec-fetch-dest"] = "video";
    if (req.headers.range && !fwdHeaders.range) fwdHeaders.range = req.headers.range;
    if (req.headers["if-range"] && !fwdHeaders["if-range"]) fwdHeaders["if-range"] = req.headers["if-range"];
    fwdHeaders.accept = fwdHeaders.accept || "*/*";
    const youtubeCookie = buildUpstreamCookieHeader(sessionId, "youtube.com");
    if (youtubeCookie) fwdHeaders.cookie = youtubeCookie;
  }

  if (isYouTubeApi) {
    fwdHeaders.referer = "https://www.youtube.com/";
    fwdHeaders.origin = "https://www.youtube.com";
    if (!fwdHeaders["content-type"]) fwdHeaders["content-type"] = "application/json";
    fwdHeaders.accept = "*/*";
  }

  const isYouTubeThemeRefresh =
    isYouTubeHost &&
    target.pathname === "/" &&
    target.searchParams.has("themeRefresh");

  // Rammerhead-inspired origin normalization for CORS-sensitive upstream APIs.
  if (!fwdHeaders.origin && fwdHeaders.referer) {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      try {
        fwdHeaders.origin = new URL(fwdHeaders.referer).origin;
      } catch {}
    }
  }

  try {
    const method = req.method || "GET";
    const body = (method !== "GET" && method !== "HEAD") ? await getReqBody(req) : undefined;

    if (isYouTubeApi && isNonCriticalYouTubeApiPath(target.pathname)) {
      const quietHeaders = { "cache-control": "no-store" };
      if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      res.writeHead(204, quietHeaders);
      res.end();
      return;
    }

    if (method === "GET") {
      const hit = cacheGet(targetUrl);
      if (hit) {
        res.writeHead(hit.status, hit.headers);
        res.end(hit.body);
        return;
      }
    }

    const retryBudget = (isYouTubeHost || host.endsWith(".google.com") || host === "google.com" || isGoogleVideo) ? 3 : 1;
    const response = await navionFetchWithRetry(targetUrl, { method, headers: fwdHeaders, body }, retryBudget);
    if (
      isYouTubeApi &&
      isNonCriticalYouTubeApiPath(target.pathname) &&
      response.status >= 400 &&
      response.status < 500
    ) {
      response.body.resume();
      const quietHeaders = { "cache-control": "no-store" };
      if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      res.writeHead(204, quietHeaders);
      res.end();
      return;
    }
    const ct = (response.headers["content-type"] || "").toLowerCase();
    const enc = response.headers["content-encoding"] || "";
    const finalUrl = response.url;
    storeResponseCookies(sessionId, host, response.headers["set-cookie"]);
      const outHeaders = buildOutHeaders(response.headers);
      if (setSessionCookie) outHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      if (typeof outHeaders.location === "string") {
        outHeaders.location = rewriteLocationHeader(outHeaders.location, targetUrl);
      }
      await runNavionHooks("afterResponse", {
        req,
        res,
        targetUrl,
        status: response.status,
        headers: outHeaders,
      });

    if (ct.includes("text/html")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
      const text = buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
      let injectRuntime = true;
      let runtimeMode = "full";
      let rewriteMode = "full";
      try {
        const htmlHost = new URL(finalUrl).hostname.toLowerCase();
        const htmlPath = new URL(finalUrl).pathname.toLowerCase();
        const isGoogleIdentityHost =
          htmlHost === "accounts.google.com" ||
          htmlHost.endsWith(".accounts.google.com");
        const isGoogleIdentityPath =
          htmlPath.includes("/servicelogin") ||
          htmlPath.includes("/signin") ||
          htmlPath.includes("/o/oauth2") ||
          htmlPath.includes("/consent");
        if (isGoogleIdentityHost || isGoogleIdentityPath) {
          injectRuntime = false;
          runtimeMode = "lite";
          rewriteMode = "nav-only";
        } else
        if (
          htmlHost === "youtube.com" ||
          htmlHost === "www.youtube.com" ||
          htmlHost === "m.youtube.com" ||
          htmlHost.endsWith(".youtube.com")
        ) {
          // Use a minimal hook runtime for YouTube to keep request routing stable
          // without the heavier DOM sink/property monkey-patching.
          injectRuntime = true;
          runtimeMode = "lite";
          rewriteMode = "nav-only";
        } else if (htmlHost === "duckduckgo.com" || htmlHost.endsWith(".duckduckgo.com")) {
          // Keep DDG routing stable while avoiding heavy monkey-patching.
          injectRuntime = true;
          runtimeMode = "lite";
          rewriteMode = "full";
        } else if (
          htmlHost === "google.com" ||
          htmlHost === "www.google.com" ||
          htmlHost.endsWith(".google.com")
        ) {
          // Keep Google routing stable while minimizing hydration side effects.
          injectRuntime = true;
          runtimeMode = "lite";
          rewriteMode = "full";
        }
      } catch {}
      const out = rewriteHtml(text, finalUrl, { injectRuntime, runtimeMode, rewriteMode });
      outHeaders["content-type"] = "text/html; charset=utf-8";
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (ct.includes("javascript") || ct.includes("ecmascript")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const source = buf.toString("utf8");
      const out = shouldBypassJsRewrite(finalUrl) ? source : rewriteJs(source, finalUrl);
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (ct.includes("text/css")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const out = rewriteCss(buf.toString("utf8"), finalUrl);
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (isGoogleVideo) {
      res.writeHead(response.status, outHeaders);
      response.body.pipe(res);
      return;
    }

    delete outHeaders["content-length"];
    const rawBuf = await collectStream(decompressStream(response.body, enc));
    if (CACHEABLE_CT.test(ct) && response.status === 200) {
      cacheSet(targetUrl, response.status, outHeaders, rawBuf);
    }
    res.writeHead(response.status, outHeaders);
    res.end(rawBuf);
  } catch (err) {
    await runNavionHooks("onError", { req, res, targetUrl, error: err });
    if (isYouTubeThemeRefresh) {
      const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
      if (dest !== "document" && dest !== "iframe" && dest !== "frame") {
        if (!res.headersSent) res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
    }
    if (isRecoverableSocketError(err) && isNonCriticalFailure(req, targetUrl)) {
      if (!res.headersSent) res.writeHead(204);
      res.end();
      return;
    }
    if (targetUrl && isNonCriticalFailure(req, targetUrl)) {
      if (!res.headersSent) res.writeHead(204);
      res.end();
      return;
    }
    errorResponse(res, 502, "Connection Failed", err.message, targetUrl);
  }
}
