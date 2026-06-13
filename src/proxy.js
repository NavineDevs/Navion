import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
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
const COOKIE_STORE_PATH = path.join(process.cwd(), ".navion-cookies.json");
let cookieStoreLoaded = false;
let cookieStoreSaveTimer = null;

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
    if (/\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|m4a|ogg|opus|wav|json)(?:$|\?)/i.test(pathname)) {
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

function normalizeTargetUrl(targetUrl) {
  try {
    const target = new URL(targetUrl);
    const host = target.hostname.toLowerCase();
    if (
      (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "html.duckduckgo.com") &&
      (target.pathname === "/ai" || target.pathname.startsWith("/ai/"))
    ) {
      const aiUrl = new URL("https://duck.ai/");
      aiUrl.pathname = target.pathname === "/ai" ? "/" : target.pathname.slice(3) || "/";
      aiUrl.search = target.search;
      aiUrl.hash = target.hash;
      return aiUrl.href;
    }
    if (
      (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "html.duckduckgo.com") &&
      target.pathname === "/l/"
    ) {
      const destination = decodeNestedUrl(target.searchParams.get("uddg"));
      if (destination) return destination;
    }
  } catch {}
  return targetUrl;
}

function decodeProxyPathTarget(pathname, search = "") {
  if (!pathname || !pathname.startsWith(PREFIX)) return null;
  const rawPath = pathname.slice(PREFIX.length);
  if (!rawPath) return null;
  const slash = rawPath.indexOf("/");
  let rawToken = slash < 0 ? rawPath : rawPath.slice(0, slash);
  const suffix = slash < 0 ? "" : rawPath.slice(slash);
  try { rawToken = decodeURIComponent(rawToken); } catch {}
  const decoded = /^https?:\/\//i.test(rawToken) ? rawToken : decode(rawToken);
  if (!/^https?:\/\//i.test(decoded)) return null;
  const target = new URL(decoded);
  if (suffix) target.pathname = target.pathname.replace(/\/?$/, "") + decodeURI(suffix);
  if (search) target.search = search;
  return target.href;
}

function isAssetRequest(req, targetUrl, contentType = "") {
  if (isDocumentRequest(req)) return false;
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (
    dest === "script" ||
    dest === "style" ||
    dest === "font" ||
    dest === "image" ||
    dest === "audio" ||
    dest === "video" ||
    dest === "track"
  ) {
    return true;
  }
  const accept = String(req.headers.accept || "").toLowerCase();
  if (
    accept.includes("javascript") ||
    accept.includes("text/css") ||
    accept.includes("image/") ||
    accept.includes("font/") ||
    accept.includes("audio/") ||
    accept.includes("video/") ||
    accept.includes("application/json")
  ) {
    return true;
  }
  if (
    contentType.includes("javascript") ||
    contentType.includes("text/css") ||
    contentType.includes("image/") ||
    contentType.includes("font/") ||
    contentType.includes("audio/") ||
    contentType.includes("video/") ||
    contentType.includes("application/json")
  ) {
    return true;
  }
  try {
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    return /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|m4a|ogg|opus|wav|json)(?:$|\?)/i.test(pathname);
  } catch {
    return false;
  }
}

function fallbackAssetResponse(req, targetUrl, contentType) {
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  const accept = String(req.headers.accept || "").toLowerCase();
  let pathname = "";
  try {
    pathname = new URL(targetUrl).pathname.toLowerCase();
  } catch {}

  if (dest === "script" || /\.(?:js|mjs)(?:$|\?)/i.test(pathname) || contentType.includes("javascript")) {
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/javascript; charset=utf-8" },
      body: "",
    };
  }
  if (dest === "style" || /\.css(?:$|\?)/i.test(pathname) || contentType.includes("text/css")) {
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "text/css; charset=utf-8" },
      body: "",
    };
  }
  if (
    dest === "font" ||
    /\.(?:woff2?|ttf|otf)(?:$|\?)/i.test(pathname) ||
    contentType.includes("font/")
  ) {
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "font/woff2" },
      body: Buffer.alloc(0),
    };
  }
  if (
    /\.json(?:$|\?)/i.test(pathname) ||
    accept.includes("application/json") ||
    contentType.includes("application/json")
  ) {
    return {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      body: "{}",
    };
  }
  return {
    status: 204,
    headers: { "cache-control": "no-store" },
    body: undefined,
  };
}

function isDocumentRequest(req) {
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  const mode = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
  const accept = String(req.headers.accept || "").toLowerCase();
  return mode === "navigate" || accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function redirectToErrorPage(res, targetUrl) {
  const location = targetUrl ? `/nav/error?u=${encodeURIComponent(encode(targetUrl))}` : "/nav/error";
  if (!res.headersSent) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  }
  res.end();
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

    if (u.pathname.startsWith("/_next/static/")) return true;
    if (isYouTubeFamily) return true;
    if (isGoogleIdentityFamily) return true;
    return false;
  } catch {
    return false;
  }
}

function isDuckDuckGoTelemetryHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "improving.duckduckgo.com" || host.endsWith(".improving.duckduckgo.com");
}

function isDuckDuckGoTelemetryPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  return path.startsWith("/t/") || path === "/e";
}

function isDroppedTelemetryTarget(hostname, pathname) {
  const host = String(hostname || "").toLowerCase();
  const path = String(pathname || "").toLowerCase();
  return (
    host === "improving.duckduckgo.com" ||
    host.endsWith(".improving.duckduckgo.com") ||
    path.startsWith("/t/static_fcp") ||
    path.startsWith("/t/page_home_searchbox_submit")
  );
}

function isAccountsYouTubeProbe(hostname, pathname) {
  const host = String(hostname || "").toLowerCase();
  const path = String(pathname || "").toLowerCase();
  return (
    (host === "accounts.youtube.com" || host.endsWith(".accounts.youtube.com")) &&
    path.startsWith("/accounts/checkconnection")
  );
}

function isGoogleIdentityDocument(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === "accounts.google.com" || host.endsWith(".accounts.google.com")) return true;
    return (
      path.includes("/servicelogin") ||
      path.includes("/signin") ||
      path.includes("/o/oauth2") ||
      path.includes("/consent")
    );
  } catch {
    return false;
  }
}

function isNoisyThirdPartyScript(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    return (
      host === "imasdk.googleapis.com" ||
      host.endsWith(".imasdk.googleapis.com") ||
      path.endsWith("/ima3.js") ||
      path.includes("/ima3.js")
    );
  } catch {
    return false;
  }
}

function rewriteDuckAiScript(source, resourceUrl) {
  try {
    const u = new URL(resourceUrl);
    const host = u.hostname.toLowerCase();
    if (host !== "duck.ai" && !host.endsWith(".duck.ai")) return source;
    const root = `${PREFIX}${encode(`${u.origin}/`)}`;
    return source
      .replace(/(["'`])\/dist\/duckai-dist\//g, `$1${root}/dist/duckai-dist/`)
      .replace(/(["'`])\/dist\/locale\//g, `$1${root}/dist/locale/`)
      .replace(/(["'`])\/country\.json/g, `$1${root}/country.json`);
  } catch {
    return source;
  }
}

function rewriteDuckDuckGoScript(source, resourceUrl) {
  try {
    const u = new URL(resourceUrl);
    const host = u.hostname.toLowerCase();
    if (host !== "duckduckgo.com" && !host.endsWith(".duckduckgo.com")) return source;
    const root = `${PREFIX}${encode(`${u.origin}/`)}`;
    return source
      .replace(/(["'`])\/dist\//g, `$1${root}/dist/`)
      .replace(/(["'`])\/_next\//g, `$1${root}/_next/`)
      .replace(/(["'`])\/country\.json/g, `$1${root}/country.json`);
  } catch {
    return source;
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
      timeout: options.timeoutMs || NAVION_CORE_CONFIG.fetch.timeoutMs,
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

function serializeCookieJars() {
  const out = {};
  for (const [sid, jar] of SESSION_JARS.entries()) {
    out[sid] = {};
    for (const [domain, domainJar] of jar.entries()) {
      out[sid][domain] = {};
      for (const [cookiePath, pathJar] of domainJar.entries()) {
        out[sid][domain][cookiePath] = Object.fromEntries(pathJar.entries());
      }
    }
  }
  return out;
}

function loadCookieStore() {
  if (cookieStoreLoaded) return;
  cookieStoreLoaded = true;
  try {
    const raw = fs.readFileSync(COOKIE_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [sid, domains] of Object.entries(parsed)) {
      if (!sid || !domains || typeof domains !== "object") continue;
      const jar = new Map();
      for (const [domain, paths] of Object.entries(domains)) {
        if (!domain || !paths || typeof paths !== "object") continue;
        const domainJar = new Map();
        const legacyValues = Object.values(paths);
        const legacyFlat = legacyValues.some((value) => typeof value === "string");
        if (legacyFlat) {
          const pathJar = new Map();
          for (const [name, value] of Object.entries(paths)) {
            if (name && typeof value === "string") {
              pathJar.set(name, { name, value, domain, path: "/", hostOnly: false, expires: 0, secure: false, httpOnly: false, sameSite: "" });
            }
          }
          if (pathJar.size) domainJar.set("/", pathJar);
        } else {
          for (const [cookiePath, cookies] of Object.entries(paths)) {
            if (!cookiePath || !cookies || typeof cookies !== "object") continue;
            const pathJar = new Map();
            for (const [name, cookie] of Object.entries(cookies)) {
              if (!name || !cookie || typeof cookie !== "object" || typeof cookie.value !== "string") continue;
              pathJar.set(name, {
                name,
                value: cookie.value,
                domain: String(cookie.domain || domain).toLowerCase().replace(/^\./, ""),
                path: String(cookie.path || cookiePath || "/"),
                hostOnly: Boolean(cookie.hostOnly),
                expires: Number(cookie.expires || 0),
                secure: Boolean(cookie.secure),
                httpOnly: Boolean(cookie.httpOnly),
                sameSite: String(cookie.sameSite || ""),
              });
            }
            if (pathJar.size) domainJar.set(cookiePath, pathJar);
          }
        }
        if (domainJar.size) jar.set(domain.toLowerCase().replace(/^\./, ""), domainJar);
      }
      if (jar.size) SESSION_JARS.set(sid, jar);
    }
  } catch {}
}

function saveCookieStoreSoon() {
  if (cookieStoreSaveTimer) return;
  cookieStoreSaveTimer = setTimeout(() => {
    cookieStoreSaveTimer = null;
    try {
      fs.writeFileSync(COOKIE_STORE_PATH, JSON.stringify(serializeCookieJars()), "utf8");
    } catch {}
  }, 250);
}

function getSessionJar(sid) {
  loadCookieStore();
  let jar = SESSION_JARS.get(sid);
  if (!jar) {
    jar = new Map();
    SESSION_JARS.set(sid, jar);
    saveCookieStoreSoon();
  }
  return jar;
}

function defaultCookiePath(pathname) {
  if (!pathname || pathname[0] !== "/") return "/";
  const idx = pathname.lastIndexOf("/");
  if (idx <= 0) return "/";
  return pathname.slice(0, idx);
}

function domainMatchesCookie(host, domain, hostOnly) {
  const h = String(host || "").toLowerCase();
  const d = String(domain || "").toLowerCase().replace(/^\./, "");
  if (!h || !d) return false;
  if (hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

function pathMatchesCookie(requestPath, cookiePath) {
  const reqPath = requestPath || "/";
  const cPath = cookiePath || "/";
  if (reqPath === cPath) return true;
  if (!reqPath.startsWith(cPath)) return false;
  if (cPath.endsWith("/")) return true;
  return reqPath.charAt(cPath.length) === "/";
}

function cookieTarget(input) {
  try {
    const u = /^https?:\/\//i.test(String(input)) ? new URL(input) : new URL(`https://${input}/`);
    return { host: u.hostname.toLowerCase(), path: u.pathname || "/", protocol: u.protocol };
  } catch {
    return { host: String(input || "").toLowerCase(), path: "/", protocol: "https:" };
  }
}

function parseSetCookiePair(line, requestHost, requestPath) {
  if (!line) return null;
  const parts = String(line).split(";").map((p) => p.trim());
  const first = parts[0];
  const i = first.indexOf("=");
  if (i <= 0) return null;
  const name = first.slice(0, i).trim();
  const value = first.slice(i + 1).trim();
  if (!name) return null;
  let domain = requestHost;
  let hostOnly = true;
  let path = defaultCookiePath(requestPath);
  let expires = 0;
  let secure = false;
  let httpOnly = false;
  let sameSite = "";
  let expired = false;
  for (let idx = 1; idx < parts.length; idx++) {
    const part = parts[idx];
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const attrValue = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (key === "domain") {
      const nextDomain = attrValue.replace(/^\./, "").toLowerCase();
      if (!domainMatchesCookie(requestHost, nextDomain, false)) return null;
      domain = nextDomain;
      hostOnly = false;
      continue;
    }
    if (key === "path") {
      path = attrValue && attrValue[0] === "/" ? attrValue : defaultCookiePath(requestPath);
      continue;
    }
    if (key === "max-age") {
      const maxAge = Number(attrValue);
      if (!Number.isNaN(maxAge)) {
        if (maxAge <= 0) expired = true;
        else expires = Date.now() + (maxAge * 1000);
      }
      continue;
    }
    if (key === "expires") {
      const expTime = Date.parse(attrValue);
      if (!Number.isNaN(expTime)) {
        if (expTime <= Date.now()) expired = true;
        else expires = expTime;
      }
      continue;
    }
    if (key === "secure") {
      secure = true;
      continue;
    }
    if (key === "httponly") {
      httpOnly = true;
      continue;
    }
    if (key === "samesite") {
      sameSite = attrValue;
      continue;
    }
  }
  return { name, value, domain, path, hostOnly, expires, secure, httpOnly, sameSite, expired };
}

function storeResponseCookies(sid, targetUrl, setCookieHeader) {
  if (!setCookieHeader) return;
  const target = cookieTarget(targetUrl);
  const jar = getSessionJar(sid);
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of list) {
    const pair = parseSetCookiePair(line, target.host, target.path);
    if (!pair) continue;
    const jarKey = pair.domain.toLowerCase().replace(/^\./, "");
    let domainJar = jar.get(jarKey);
    if (!domainJar) {
      domainJar = new Map();
      jar.set(jarKey, domainJar);
    }
    let pathJar = domainJar.get(pair.path);
    if (!pathJar) {
      pathJar = new Map();
      domainJar.set(pair.path, pathJar);
    }
    if (pair.expired) pathJar.delete(pair.name);
    else pathJar.set(pair.name, pair);
    if (pathJar.size === 0) domainJar.delete(pair.path);
    if (domainJar.size === 0) jar.delete(jarKey);
  }
  if (jar.size === 0) SESSION_JARS.delete(sid);
  saveCookieStoreSoon();
}

function buildUpstreamCookieHeader(sid, targetUrl) {
  loadCookieStore();
  const jar = SESSION_JARS.get(sid);
  if (!jar) return "";
  const target = cookieTarget(targetUrl);
  const now = Date.now();
  let dirty = false;

  const out = new Map();
  for (const [domain, domainJar] of jar.entries()) {
    for (const [cookiePath, pathJar] of domainJar.entries()) {
      if (!pathMatchesCookie(target.path, cookiePath)) continue;
      for (const [name, cookie] of pathJar.entries()) {
        if (!domainMatchesCookie(target.host, cookie.domain || domain, cookie.hostOnly)) continue;
        if (cookie.expires && cookie.expires <= now) {
          pathJar.delete(name);
          dirty = true;
          continue;
        }
        if (cookie.secure && target.protocol !== "https:") continue;
        out.set(name, cookie.value);
      }
      if (pathJar.size === 0) {
        domainJar.delete(cookiePath);
        dirty = true;
      }
    }
    if (domainJar.size === 0) {
      jar.delete(domain);
      dirty = true;
    }
  }
  if (dirty) saveCookieStoreSoon();
  if (out.size === 0) return "";
  return Array.from(out.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

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

function headersWithoutSessionCookie(headers) {
  const out = { ...headers };
  delete out["set-cookie"];
  delete out["Set-Cookie"];
  return out;
}

function headersWithSessionCookie(headers, sessionId, shouldSetCookie) {
  const out = { ...headers };
  if (shouldSetCookie) out["set-cookie"] = navionSessionCookieValue(sessionId);
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
    targetUrl = normalizeTargetUrl(decode(encoded));
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
          const decodedRef = decodeProxyPathTarget(ref.pathname, ref.search);
          if (decodedRef) fwdHeaders["referer"] = decodedRef;
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
  if (isYouTubeHost && target.searchParams.has("themeRefresh")) {
    target.searchParams.delete("themeRefresh");
    targetUrl = target.href;
  }
  const isYouTubeApi = isYouTubeHost && target.pathname.startsWith("/youtubei/");
  const isYouTubeTelemetry = isYouTubeHost && isNonCriticalYouTubeTelemetryPath(target.pathname);
  const isDuckDuckGoTelemetry = isDuckDuckGoTelemetryHost(host) && isDuckDuckGoTelemetryPath(target.pathname);
  const navRequest = isDocumentRequest(req);
  if (isDroppedTelemetryTarget(host, target.pathname)) {
    if (navRequest) {
      const fallback = fallbackAssetResponse(req, targetUrl, "");
      if (setSessionCookie) fallback.headers["set-cookie"] = navionSessionCookieValue(sessionId);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }
    const quietHeaders = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "content-length": "0" };
    if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(200, quietHeaders);
    res.end("");
    return;
  }
  const isAccountsYouTubeHealthProbe = isAccountsYouTubeProbe(host, target.pathname);
  const isYouTubeGenerate204 =
    target.pathname === "/generate_204" &&
    (isYouTubeHost || host === "ytimg.com" || host.endsWith(".ytimg.com"));
  const upstreamCookie = buildUpstreamCookieHeader(sessionId, targetUrl);
  if (upstreamCookie) fwdHeaders.cookie = upstreamCookie;
    if (isYouTubeGenerate204) {
      const quickHeaders = { "cache-control": "no-store" };
      if (setSessionCookie) quickHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      quickHeaders["content-type"] = "text/plain; charset=utf-8";
      quickHeaders["content-length"] = "0";
      res.writeHead(200, quickHeaders);
      res.end("");
      return;
    }
  if (isYouTubeTelemetry) {
    const quietHeaders = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "content-length": "0" };
    if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(200, quietHeaders);
    res.end("");
    return;
  }
  if (isDuckDuckGoTelemetry || isAccountsYouTubeHealthProbe) {
    const quietHeaders = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "content-length": "0" };
    if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(200, quietHeaders);
    res.end("");
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
    const youtubeCookie = buildUpstreamCookieHeader(sessionId, "https://www.youtube.com/");
    if (youtubeCookie) fwdHeaders.cookie = youtubeCookie;
  }

  if (isYouTubeApi) {
    fwdHeaders.referer = "https://www.youtube.com/";
    fwdHeaders.origin = "https://www.youtube.com";
    if (!fwdHeaders["content-type"]) fwdHeaders["content-type"] = "application/json";
    fwdHeaders.accept = "*/*";
  }

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
      const quietHeaders = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "content-length": "0" };
      if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      res.writeHead(200, quietHeaders);
      res.end("");
      return;
    }

    if (method === "GET") {
      const hit = cacheGet(targetUrl);
      if (hit) {
        res.writeHead(hit.status, headersWithSessionCookie(hit.headers, sessionId, setSessionCookie));
        res.end(hit.body);
        return;
      }
    }

    const documentRequest = isDocumentRequest(req);
    const requestTimeoutMs = documentRequest ? NAVION_CORE_CONFIG.fetch.timeoutMs : 7000;
    const retryBudget = documentRequest && (isYouTubeHost || host.endsWith(".google.com") || host === "google.com" || isGoogleVideo) ? 2 : 0;
    const response = await navionFetchWithRetry(targetUrl, { method, headers: fwdHeaders, body, timeoutMs: requestTimeoutMs }, retryBudget);
    if (
      isYouTubeApi &&
      isNonCriticalYouTubeApiPath(target.pathname) &&
      response.status >= 400 &&
      response.status < 500
    ) {
      response.body.resume();
      const quietHeaders = { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "content-length": "0" };
      if (setSessionCookie) quietHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
      res.writeHead(200, quietHeaders);
      res.end("");
      return;
    }
    const ct = (response.headers["content-type"] || "").toLowerCase();
    const enc = response.headers["content-encoding"] || "";
    const finalUrl = response.url;
    storeResponseCookies(sessionId, finalUrl || targetUrl, response.headers["set-cookie"]);
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

    if (response.status >= 400 && isNonCriticalFailure(req, targetUrl)) {
      response.body.resume();
      const fallback = fallbackAssetResponse(req, targetUrl, ct);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }

    if (response.status >= 500) {
      response.body.resume();
      if (isDocumentRequest(req)) {
        redirectToErrorPage(res, targetUrl);
        return;
      }
      const fallback = fallbackAssetResponse(req, targetUrl, ct);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }

    if (ct.includes("text/html") && isAssetRequest(req, targetUrl, ct)) {
      response.body.resume();
      const fallback = fallbackAssetResponse(req, targetUrl, ct);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }

    if (ct.includes("text/html")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
      const text = buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
      if (isGoogleIdentityDocument(finalUrl)) {
        outHeaders["content-type"] = "text/html; charset=utf-8";
        delete outHeaders["content-length"];
        res.writeHead(response.status, outHeaders);
        res.end(text);
        return;
      }
      let injectRuntime = true;
      let runtimeMode = "mask";
      let rewriteMode = "full";
      try {
        const htmlHost = new URL(finalUrl).hostname.toLowerCase();
        if (
          htmlHost === "navianime.vercel.app"
        ) {
          injectRuntime = true;
          runtimeMode = "navianime";
          rewriteMode = "full";
        } else if (
          htmlHost === "youtube.com" ||
          htmlHost === "www.youtube.com" ||
          htmlHost === "m.youtube.com" ||
          htmlHost.endsWith(".youtube.com")
        ) {
          injectRuntime = true;
          runtimeMode = "youtube";
          rewriteMode = "nav-only";
        } else if (
          htmlHost === "duck.ai" ||
          htmlHost.endsWith(".duck.ai") ||
          htmlHost === "duckduckgo.com" ||
          htmlHost.endsWith(".duckduckgo.com")
        ) {
          injectRuntime = true;
          runtimeMode = "lite";
          rewriteMode = "full";
        } else if (
          htmlHost === "google.com" ||
          htmlHost === "www.google.com" ||
          htmlHost.endsWith(".google.com")
        ) {
          injectRuntime = true;
          runtimeMode = "lite";
          rewriteMode = "full";
        }
      } catch {}
      const htmlBase = isYouTubeHost ? targetUrl : finalUrl;
      const out = rewriteHtml(text, htmlBase, { injectRuntime, runtimeMode, rewriteMode });
      outHeaders["content-type"] = "text/html; charset=utf-8";
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (ct.includes("javascript") || ct.includes("ecmascript")) {
      if (isNoisyThirdPartyScript(finalUrl)) {
        delete outHeaders["content-length"];
        outHeaders["content-type"] = "application/javascript; charset=utf-8";
        response.body.resume();
        res.writeHead(200, outHeaders);
        res.end("");
        return;
      }
      const buf = await collectStream(decompressStream(response.body, enc));
      const source = buf.toString("utf8");
      const prepared = rewriteDuckDuckGoScript(rewriteDuckAiScript(source, finalUrl), finalUrl);
      const out = shouldBypassJsRewrite(finalUrl) ? prepared : rewriteJs(prepared, finalUrl);
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
      cacheSet(targetUrl, response.status, headersWithoutSessionCookie(outHeaders), rawBuf);
    }
    res.writeHead(response.status, outHeaders);
    res.end(rawBuf);
  } catch (err) {
    await runNavionHooks("onError", { req, res, targetUrl, error: err });
    if (targetUrl && isYouTubeLikeHost(new URL(targetUrl).hostname.toLowerCase()) && new URL(targetUrl).searchParams.has("themeRefresh")) {
      const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
      if (dest !== "document" && dest !== "iframe" && dest !== "frame") {
        if (!res.headersSent) res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
    }
    if (isRecoverableSocketError(err) && isNonCriticalFailure(req, targetUrl)) {
      const fallback = fallbackAssetResponse(req, targetUrl, "");
      if (!res.headersSent) res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }
    if (targetUrl && isNonCriticalFailure(req, targetUrl)) {
      const fallback = fallbackAssetResponse(req, targetUrl, "");
      if (!res.headersSent) res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }
    if (targetUrl && isDocumentRequest(req)) {
      redirectToErrorPage(res, targetUrl);
      return;
    }
    if (targetUrl) {
      const fallback = fallbackAssetResponse(req, targetUrl, "");
      if (!res.headersSent) res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }
    errorResponse(res, 502, "Connection Failed", err.message, targetUrl);
  }
}
