import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { decode, encode, rewriteUrl } from "./rewriters/url.js";
import { rewriteHtml } from "./rewriters/html.js";
import { rewriteJs, rewriteCdnUrlLiterals } from "./rewriters/js.js";
import { rewriteCss } from "./rewriters/css.js";
import { NAVION_CORE_CONFIG } from "./server/config/navion.config.js";
import { runNavionHooks } from "./server/pipeline/hooks.js";
import {
  connectThroughUpstreamProxy,
  resolveUpstreamProxyForHost,
  shouldUseUpstreamProxy,
} from "./internal/upstream-proxy.js";

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
  "x-content-security-policy", "x-webkit-csp",
  "strict-transport-security",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "report-to",
]);

const BASE_HEADERS = { ...NAVION_CORE_CONFIG.baseHeaders };

function isNoiseTarget(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (
      host === "improving.duckduckgo.com" ||
      host.endsWith(".improving.duckduckgo.com") ||
      host === "googleads.g.doubleclick.net" ||
      host.endsWith(".doubleclick.net")
    ) {
      return true;
    }
    if (
      pathname.startsWith("/youtubei/v1/log_event") ||
      pathname.startsWith("/youtubei/v1/feedback") ||
      pathname.startsWith("/api/stats/") ||
      pathname.startsWith("/ptracking") ||
      pathname.indexOf("/t/static_fcp") === 0 ||
      pathname.indexOf("/t/page_home_searchbox_submit") === 0
    ) {
      return true;
    }
  } catch {}
  return false;
}

function isNonCriticalFailure(req, targetUrl) {
  return isNoiseTarget(targetUrl);
}

function isPornhubHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "pornhub.com" || host.endsWith(".pornhub.com");
}

function isAdultContentHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (isPornhubHost(host)) return true;
  if (host.endsWith(".phncdn.com") || host.endsWith(".phprcdn.com") || host.endsWith(".trafficjunky.net")) return true;
  if (host === "xvideos.com" || host.endsWith(".xvideos.com")) return true;
  if (host.endsWith(".xvideos-cdn.com")) return true;
  if (host === "xhamster.com" || host.endsWith(".xhamster.com")) return true;
  if (host === "xhamster.desi" || host.endsWith(".xhamster.desi")) return true;
  if (host === "eporner.com" || host.endsWith(".eporner.com")) return true;
  if (host === "redtube.com" || host.endsWith(".redtube.com")) return true;
  if (host === "spankbang.com" || host.endsWith(".spankbang.com")) return true;
  if (host === "xnxx.com" || host.endsWith(".xnxx.com")) return true;
  if (host === "uncensoredhentai.xxx" || host.endsWith(".uncensoredhentai.xxx")) return true;
  if (host === "hentaihaven.xxx" || host.endsWith(".hentaihaven.xxx")) return true;
  if (host === "hanime.tv" || host.endsWith(".hanime.tv")) return true;
  if (host.endsWith(".hstream.moe")) return true;
  if (host.endsWith(".sb-cd.com") || host.endsWith(".streamsb.net")) return true;
  if (host.endsWith(".doodstream.com") || host.endsWith(".doodcdn.co")) return true;
  return false;
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
    if (host === "m.youtube.com") {
      target.hostname = "www.youtube.com";
      return target.href;
    }
    if (host === "pornhub.com") {
      target.hostname = "www.pornhub.com";
      return target.href;
    }
    if (host === "xvideos.com") {
      target.hostname = "www.xvideos.com";
      return target.href;
    }
    if (host === "xhamster.com" || host === "xhamster.desi") {
      target.hostname = host === "xhamster.desi" ? "xhamster.desi" : "xhamster.com";
      return target.href;
    }
    if (
      (host === "duckduckgo.com" || host === "www.duckduckgo.com" || host === "html.duckduckgo.com") &&
      (target.pathname === "/ai" || target.pathname.startsWith("/ai/") || target.searchParams.get("duckai") === "1" || target.searchParams.get("ia") === "chat" || target.searchParams.get("iax") === "chat")
    ) {
      return "https://duck.ai/";
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

function isMediaManifestTarget(targetUrl, contentType = "") {
  try {
    const path = new URL(targetUrl).pathname.toLowerCase();
    return (
      path.endsWith(".m3u8") ||
      path.endsWith(".mpd") ||
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple.mpegurl") ||
      contentType.includes("dash+xml")
    );
  } catch {
    return contentType.includes("mpegurl") || contentType.includes("vnd.apple.mpegurl") || contentType.includes("dash+xml");
  }
}

function isStreamableMediaTarget(targetUrl, contentType = "") {
  try {
    const path = new URL(targetUrl).pathname.toLowerCase();
    if (path.includes("/videoplayback")) return true;
    if (/\.(?:mp4|m4v|webm|mov|mkv|avi|ts|m2ts|aac|m4a|mp3|ogg|opus|wav)(?:$|\?)/i.test(path)) return true;
  } catch {}
  return contentType.includes("video/") || contentType.includes("audio/") || contentType.includes("application/octet-stream");
}

function rewriteMediaManifest(source, baseUrl) {
  const rewriteManifestUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("#") || /^(?:data:|blob:|javascript:)/i.test(raw)) return value;
    return rewriteUrl(raw, baseUrl);
  };
  return String(source || "")
    .replace(/\bURI=(["'])([^"']+)\1/g, (m, q, value) => `URI=${q}${rewriteManifestUrl(value)}${q}`)
    .replace(/\bURL=(["'])([^"']+)\1/g, (m, q, value) => `URL=${q}${rewriteManifestUrl(value)}${q}`)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/(["'])(https?:\/\/[^"']+|\/\/[^"']+|\/[^"']+|\.{1,2}\/[^"']+)\1/g, (m, q, value) => `${q}${rewriteManifestUrl(value)}${q}`);
      }
      return line.replace(trimmed, rewriteManifestUrl(trimmed));
    })
    .join("\n");
}

function rewriteJsonValue(value, baseUrl, depth = 0) {
  if (depth > 18 || value == null) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(?:https?:\/\/|\/\/|\/(?!\/)|\.{1,2}\/)[^\s"'<>]+$/i.test(trimmed)) return rewriteUrl(value, baseUrl);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteJsonValue(entry, baseUrl, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = rewriteJsonValue(entry, baseUrl, depth + 1);
    return out;
  }
  return value;
}

function rewriteJsonText(source, baseUrl) {
  try {
    return JSON.stringify(rewriteJsonValue(JSON.parse(source), baseUrl));
  } catch {
    return source;
  }
}

function sanitizeNhPlayerHtml(source, resourceUrl) {
  try {
    const u = new URL(resourceUrl);
    const host = u.hostname.toLowerCase();
    if (host !== "nhplayer.com" && !host.endsWith(".nhplayer.com")) return source;
    if (!u.pathname.endsWith("/player.php")) return source;
    let mediaUrl = "";
    try {
      const token = u.searchParams.get("vid") || "";
      const padded = token + "=".repeat((4 - (token.length % 4)) % 4);
      const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const candidate = decoded.split("|")[0];
      if (/^https?:\/\//i.test(candidate)) mediaUrl = rewriteUrl(candidate, resourceUrl);
    } catch {}
    const seedResult = mediaUrl ? `window._pC=window._pC||{};window._pC.result={url:${JSON.stringify(mediaUrl)}};window._pC.error=null;` : "";
    return String(source || "")
      .replace(/_f\.push\(/g, "void(")
      .replace(/typeof\s+v\.domResult\s*===\s*(['"])function\1/g, "false")
      .replace(/if\s*\(\s*_f\.length\s*>\s*0\s*\)\s*\{[\s\S]*?try\s*\{\s*w\.stop\(\)\s*;\s*\}\s*catch\s*\(e\)\s*\{\s*\}\s*[\s\S]*?\}/g, "if(false){}")
      .replace(/if\s*\(\s*flags\.length\s*>\s*0\s*&&\s*w\._pC\s*\)\s*\{?\s*w\._pC\._postFlags\s*=\s*flags\s*;?\s*\}?/g, "if(false){}")
      .replace(/if\s*\(\s*w\._pC\s*\)\s*w\._pC\.error\s*=\s*new\s+Error\((['"])blocked\1\)\s*;/g, "")
      .replace(/\(function\s+checkResult\s*\(\)\s*\{/, `${seedResult}(function checkResult(){`);
  } catch {
    return source;
  }
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
  if (search && !target.search) target.search = search;
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

function shouldUseAssetFallback(req, targetUrl, contentType = "") {
  if (!isAssetRequest(req, targetUrl, contentType)) return false;
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  const ct = String(contentType || "").toLowerCase();
  if ((dest === "style" || /\.css(?:$|\?)/i.test(new URL(targetUrl).pathname)) && !ct.includes("text/css")) return true;
  if ((dest === "script" || /\.(?:js|mjs)(?:$|\?)/i.test(new URL(targetUrl).pathname)) && !ct.includes("javascript") && !ct.includes("ecmascript")) return true;
  return ct.includes("text/html");
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

function isYouTubeRelatedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (isYouTubeLikeHost(host)) return true;
  return (
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com") ||
    host.endsWith(".gstatic.com") ||
    host.endsWith(".ytimg.com") ||
    host.endsWith(".googleapis.com") ||
    host.endsWith(".doubleclick.net") ||
    host.includes("youtube")
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
    code === "ERR_INVALID_PROTOCOL" ||
    code === "EPROTO" ||
    code === "ERR_SSL_VERSION_OR_CIPHER_MISMATCH"
  ) {
    return true;
  }
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("econn") ||
    msg.includes("epipe") ||
    msg.includes("etimedout") ||
    msg.includes("err_invalid_") ||
    msg.includes("alpn") ||
    msg.includes("ssl") ||
    msg.includes("tls") ||
    msg.includes("timed out")
  );
}

async function resolveFetchProxy(hostname, options) {
  const config = NAVION_CORE_CONFIG.upstreamProxy;
  const forced = options?.upstreamProxy || null;
  if (forced) return forced;
  return resolveUpstreamProxyForHost(hostname, config, {
    probeHost: hostname,
    timeoutMs: Math.min(options?.timeoutMs || NAVION_CORE_CONFIG.fetch.timeoutMs, 5000),
  });
}

function rawFetch(targetUrl, options, redirectCount = 0) {
  return rawFetchInternal(targetUrl, options, redirectCount);
}

function rawFetchInternal(targetUrl, options, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const targetPort = parseInt(parsed.port, 10) || (isHttps ? 443 : 80);
    const timeoutMs = options.timeoutMs || NAVION_CORE_CONFIG.fetch.timeoutMs;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    resolveFetchProxy(parsed.hostname, options).then((proxy) => {
      const useAgent = !proxy && !options.fresh ? (isHttps ? httpsAgent : httpAgent) : false;
      const reqOptions = {
        hostname: parsed.hostname,
        port: targetPort,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        agent: useAgent,
        timeout: timeoutMs,
      };

      if (proxy) {
        reqOptions.agent = false;
        reqOptions.createConnection = (_opts, cb) => {
          connectThroughUpstreamProxy(proxy, parsed.hostname, targetPort, isHttps, timeoutMs)
            .then((socket) => cb(null, socket))
            .catch((err) => cb(err));
        };
      }

      const req = lib.request(reqOptions, (res) => {
        const { statusCode: status, headers } = res;
        const location = headers["location"];

        if (status >= 300 && status < 400 && location && redirectCount < MAX_REDIRECTS) {
          res.resume();
          rawFetchInternal(new URL(location, targetUrl).href, options, redirectCount + 1)
            .then((value) => finish(resolve, value))
            .catch((err) => finish(reject, err));
          return;
        }

        finish(resolve, { status, headers, body: res, url: targetUrl });
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });

      if (options.body) req.write(options.body);
      req.end();
    }).catch(reject);
  });
}

async function navionFetchWithRetry(targetUrl, options, retries = 1) {
  let lastError = null;
  let proxyRetried = false;
  const hostname = (() => {
    try {
      return new URL(targetUrl).hostname;
    } catch {
      return "";
    }
  })();
  const proxyConfig = NAVION_CORE_CONFIG.upstreamProxy;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fetchOptions = attempt > 0 ? { ...options, fresh: true } : { ...options };
      if (
        !proxyRetried &&
        !fetchOptions.upstreamProxy &&
        proxyConfig?.auto &&
        shouldUseUpstreamProxy(hostname, proxyConfig)
      ) {
        const discovered = await resolveUpstreamProxyForHost(hostname, proxyConfig, { probeHost: hostname });
        if (discovered) fetchOptions.upstreamProxy = discovered;
      }
      return await rawFetch(targetUrl, fetchOptions);
    } catch (error) {
      lastError = error;
      if (
        !proxyRetried &&
        !options?.upstreamProxy &&
        isRecoverableSocketError(error) &&
        proxyConfig &&
        (proxyConfig.auto || proxyConfig.proxy) &&
        shouldUseUpstreamProxy(hostname, proxyConfig)
      ) {
        const discovered = await resolveUpstreamProxyForHost(hostname, proxyConfig, { probeHost: hostname });
        if (discovered) {
          proxyRetried = true;
          try {
            return await rawFetch(targetUrl, { ...options, fresh: true, upstreamProxy: discovered });
          } catch (retryError) {
            lastError = retryError;
          }
        }
      }
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

function resolveRequestOrigin(req) {
  const requestOrigin = req?.headers?.origin;
  if (requestOrigin) return requestOrigin;
  if (req?.headers?.referer) {
    try {
      return new URL(req.headers.referer).origin;
    } catch {}
  }
  if (req?.headers?.host) {
    try {
      return new URL(`http://${req.headers.host}`).origin;
    } catch {}
  }
  return null;
}

function buildOutHeaders(resHeaders, req) {
  const requestOrigin = resolveRequestOrigin(req);
  const out = {
    "cross-origin-resource-policy": "cross-origin",
    "access-control-expose-headers": "*",
    "timing-allow-origin": requestOrigin || "*",
  };
  if (requestOrigin) {
    out["access-control-allow-origin"] = requestOrigin;
    out["access-control-allow-credentials"] = "true";
  } else {
    out["access-control-allow-origin"] = "*";
  }
  for (const [k, v] of Object.entries(resHeaders)) {
    if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
  }
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (DROP_RES.has(lower)) delete out[key];
  }
  delete out["set-cookie"];
  delete out["Set-Cookie"];
  if (requestOrigin) {
    out["access-control-allow-origin"] = requestOrigin;
    out["access-control-allow-credentials"] = "true";
  }
  return out;
}

function buildCorsPreflightHeaders(req) {
  const requestOrigin = resolveRequestOrigin(req) || "*";
  const requestHeaders = req.headers["access-control-request-headers"] || "range, if-range, accept, accept-language, content-type, authorization, x-requested-with, x-youtube-client-name, x-youtube-client-version, x-goog-authuser, x-goog-visitor-id, x-origin, x-client-data";
  const out = {
    "access-control-allow-origin": requestOrigin,
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": requestHeaders,
    "access-control-max-age": "86400",
    "content-length": "0",
    "cache-control": "no-store",
  };
  if (req.headers.origin) out["access-control-allow-credentials"] = "true";
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

function sanitizeProxyHeaders(headers, req) {
  const out = buildOutHeaders(headers || {}, req);
  if (typeof out.location === "string") out.location = rewriteLocationHeader(out.location, req?.navionTargetUrl || req?.url || "");
  return out;
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

function proxyFetchErrorResponse(res, req, status, message, targetUrl) {
  if (isDocumentRequest(req)) {
    errorResponse(res, status, "Connection Failed", message, targetUrl);
    return;
  }
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (!res.headersSent) res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { code: status, message: message || "Proxy fetch failed" } }));
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
  req.navionTargetUrl = targetUrl;

  const inCookies = parseCookieHeader(req.headers.cookie || "");
  const sessionId = inCookies.nv_sid || newNavionSessionId();
  const setSessionCookie = !inCookies.nv_sid;

  if ((req.method || "GET").toUpperCase() === "OPTIONS") {
    const headers = buildCorsPreflightHeaders(req);
    if (setSessionCookie) headers["set-cookie"] = navionSessionCookieValue(sessionId);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const fwdHeaders = { ...BASE_HEADERS };

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
    req.navionTargetUrl = targetUrl;
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

  if (isAdultContentHost(host)) {
    fwdHeaders.referer = fwdHeaders.referer || `${target.origin}/`;
    if ((req.method || "GET").toUpperCase() === "GET" || (req.method || "GET").toUpperCase() === "HEAD") {
      delete fwdHeaders.origin;
    } else {
      fwdHeaders.origin = fwdHeaders.origin || target.origin;
    }
    fwdHeaders["accept-language"] = fwdHeaders["accept-language"] || "en-US,en;q=0.9";
    fwdHeaders.accept = fwdHeaders.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
    fwdHeaders["cache-control"] = "max-age=0";
    fwdHeaders["upgrade-insecure-requests"] = "1";
    fwdHeaders["sec-fetch-site"] = fwdHeaders["sec-fetch-site"] || "none";
    fwdHeaders["sec-fetch-mode"] = fwdHeaders["sec-fetch-mode"] || "navigate";
    fwdHeaders["sec-fetch-dest"] = fwdHeaders["sec-fetch-dest"] || "document";
  }

  if (isGoogleVideo) {
    fwdHeaders.referer = "https://www.youtube.com/";
    delete fwdHeaders.origin;
    delete fwdHeaders.cookie;
    delete fwdHeaders.authorization;
    delete fwdHeaders["x-goog-authuser"];
    delete fwdHeaders["x-goog-visitor-id"];
    fwdHeaders["sec-fetch-site"] = "cross-site";
    fwdHeaders["sec-fetch-mode"] = "no-cors";
    fwdHeaders["sec-fetch-dest"] = req.headers["sec-fetch-dest"] || "video";
    if (req.headers.range) fwdHeaders.range = req.headers.range;
    if (req.headers["if-range"]) fwdHeaders["if-range"] = req.headers["if-range"];
    fwdHeaders.accept = "*/*";
    fwdHeaders["accept-language"] = fwdHeaders["accept-language"] || "en-US,en;q=0.9";
    fwdHeaders["user-agent"] = fwdHeaders["user-agent"] || BASE_HEADERS["user-agent"];
    const clientIp =
      String(req.headers["cf-connecting-ip"] || "").trim() ||
      String(req.headers["x-real-ip"] || "").trim() ||
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (clientIp) {
      fwdHeaders["x-forwarded-for"] = clientIp;
      fwdHeaders["x-real-ip"] = clientIp;
    }
  }

  if (isYouTubeApi || isYouTubeRelatedHost(host)) {
    if (isYouTubeApi || host.includes("youtube") || host.endsWith(".youtube.com")) {
      fwdHeaders.referer = fwdHeaders.referer || "https://www.youtube.com/";
      fwdHeaders.origin = fwdHeaders.origin || "https://www.youtube.com";
    }
    if (isYouTubeApi && !fwdHeaders["content-type"]) fwdHeaders["content-type"] = "application/json";
    if (isYouTubeApi || host.includes("suggestqueries")) fwdHeaders.accept = fwdHeaders.accept || "*/*";
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
    const retryCount = documentRequest && (
      isYouTubeHost ||
      isAdultContentHost(host) ||
      host.endsWith(".google.com") ||
      host === "google.com" ||
      isGoogleVideo
    ) ? 3 : documentRequest ? 1 : isGoogleVideo || isYouTubeApi ? 2 : 0;
    const response = await navionFetchWithRetry(targetUrl, { method, headers: fwdHeaders, body, timeoutMs: requestTimeoutMs }, retryCount);
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
    const outHeaders = sanitizeProxyHeaders(response.headers, req);
    if (setSessionCookie) outHeaders["set-cookie"] = navionSessionCookieValue(sessionId);
    await runNavionHooks("afterResponse", {
      req,
      res,
      targetUrl,
      status: response.status,
      headers: outHeaders,
    });

    if (response.status >= 400 && isNoiseTarget(targetUrl)) {
      response.body.resume();
      const fallback = fallbackAssetResponse(req, targetUrl, ct);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }

    if (isGoogleVideo && response.status >= 400 && response.status < 500) {
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      response.body.pipe(res);
      return;
    }

    if (response.status >= 500) {
      response.body.resume();
      if (isDocumentRequest(req)) {
        redirectToErrorPage(res, targetUrl);
        return;
      }
      if (isNoiseTarget(targetUrl)) {
        const fallback = fallbackAssetResponse(req, targetUrl, ct);
        res.writeHead(fallback.status, fallback.headers);
        res.end(fallback.body);
        return;
      }
      if (isGoogleVideo) {
        res.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        res.end("");
        return;
      }
      res.writeHead(response.status, outHeaders);
      res.end("");
      return;
    }

    if (shouldUseAssetFallback(req, targetUrl, ct)) {
      response.body.resume();
      const fallback = fallbackAssetResponse(req, targetUrl, ct);
      res.writeHead(fallback.status, fallback.headers);
      res.end(fallback.body);
      return;
    }

    if (isMediaManifestTarget(finalUrl || targetUrl, ct)) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const out = rewriteMediaManifest(buf.toString("utf8"), finalUrl || targetUrl);
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (isStreamableMediaTarget(finalUrl || targetUrl, ct) && !enc) {
      res.writeHead(response.status, outHeaders);
      response.body.pipe(res);
      return;
    }

    if (ct.includes("text/html")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
      let text = buf.toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
      text = sanitizeNhPlayerHtml(text, finalUrl || targetUrl);
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
      let injectYouTubeHelper = false;
      try {
        const htmlHost = new URL(finalUrl).hostname.toLowerCase();
        if (
          htmlHost === "navianime.vercel.app"
        ) {
          injectRuntime = true;
          runtimeMode = "full";
          rewriteMode = "full";
        } else if (isAdultContentHost(htmlHost)) {
          injectRuntime = true;
          runtimeMode = "full";
          rewriteMode = "full";
        } else if (
          htmlHost === "youtube.com" ||
          htmlHost === "www.youtube.com" ||
          htmlHost === "m.youtube.com" ||
          htmlHost.endsWith(".youtube.com")
        ) {
          injectRuntime = true;
          const ytDest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
          runtimeMode = (ytDest === "iframe" || ytDest === "frame") ? "lite-nav" : "full";
          rewriteMode = "full";
          injectYouTubeHelper = true;
        } else if (
          htmlHost === "duck.ai" ||
          htmlHost.endsWith(".duck.ai") ||
          htmlHost === "duckduckgo.com" ||
          htmlHost.endsWith(".duckduckgo.com")
        ) {
          injectRuntime = true;
          runtimeMode = "lite-nav";
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
      const out = rewriteHtml(text, htmlBase, { injectRuntime, runtimeMode, rewriteMode, injectYouTubeHelper });
      outHeaders["content-type"] = "text/html; charset=utf-8";
      delete outHeaders["content-length"];
      res.writeHead(response.status, outHeaders);
      res.end(out);
      return;
    }

    if (ct.includes("application/json") || ct.includes("+json")) {
      const buf = await collectStream(decompressStream(response.body, enc));
      const out = rewriteJsonText(buf.toString("utf8"), finalUrl || targetUrl);
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
      const out = shouldBypassJsRewrite(finalUrl) ? rewriteCdnUrlLiterals(prepared, finalUrl) : rewriteJs(prepared, finalUrl);
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
    if (targetUrl && isNoiseTarget(targetUrl)) {
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
    if (targetUrl) {
      try {
        const failedHost = new URL(targetUrl).hostname.toLowerCase();
        const failedPath = new URL(targetUrl).pathname;
        if (failedHost.endsWith(".googlevideo.com") || failedHost === "googlevideo.com") {
          if (!res.headersSent) {
            res.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-navion-playback": "blocked" });
          }
          res.end("");
          return;
        }
        if (isYouTubeLikeHost(failedHost) && failedPath.startsWith("/youtubei/")) {
          proxyFetchErrorResponse(res, req, 502, err?.message || "Proxy fetch failed.", targetUrl);
          return;
        }
      } catch {}
    }
    if (targetUrl && isDocumentRequest(req)) {
      redirectToErrorPage(res, targetUrl);
      return;
    }
    if (targetUrl) {
      if (isNoiseTarget(targetUrl)) {
        const fallback = fallbackAssetResponse(req, targetUrl, "");
        if (!res.headersSent) res.writeHead(fallback.status, fallback.headers);
        res.end(fallback.body);
        return;
      }
      if (isDocumentRequest(req)) {
        redirectToErrorPage(res, targetUrl);
        return;
      }
    }
    proxyFetchErrorResponse(res, req, 502, err?.message || "Proxy fetch failed.", targetUrl);
  }
}

export const __navionTestInternals = {
  buildCorsPreflightHeaders,
  buildOutHeaders,
  isStreamableMediaTarget,
  shouldUseAssetFallback,
  rewriteLocationHeader,
  rewriteMediaManifest,
};
