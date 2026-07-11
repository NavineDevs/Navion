export const PREFIX = "/nv/";

const BYPASS_SCHEME_RE = /^(?:javascript:|data:|blob:|mailto:|tel:|about:|chrome:|edge:|firefox:|opera:|brave:|file:|filesystem:)/i;
const NAVION_SHELL_PATHS = new Set([
  "/app",
  "/index.html",
  "/api/fetch",
  "/api/navion-status",
  "/favicon.ico",
  "/generate_204",
  "/nav/home",
  "/nav/error",
  "/nv.sw.js",
  "/nv.client.js",
  "/nv.register.js",
]);

export function encode(url) {
  return Buffer.from(encodeURIComponent(url))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function decode(encoded) {
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return decodeURIComponent(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
}

const PATH_MARKERS = ["dist/", "_next/", "country.json", "duckchat/", "static/"];

function tryDecodeNavionToken(rawToken) {
  let token = rawToken;
  try { token = decodeURIComponent(rawToken); } catch {}
  try {
    const decoded = /^https?:\/\//i.test(token) ? token : decode(token);
    if (decoded && /^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  return null;
}

function isExactNavionToken(rawToken, decoded) {
  if (!decoded) return false;
  try {
    return encode(decoded) === rawToken;
  } catch {
    return false;
  }
}

function splitNavionRawPath(rawPath) {
  const slash = rawPath.indexOf("/");
  if (slash >= 0) {
    return { rawToken: rawPath.slice(0, slash), suffix: rawPath.slice(slash) };
  }
  for (const marker of PATH_MARKERS) {
    const index = rawPath.indexOf(marker);
    if (index > 0) {
      return { rawToken: rawPath.slice(0, index), suffix: `/${rawPath.slice(index)}` };
    }
  }
  const full = tryDecodeNavionToken(rawPath);
  if (full && isExactNavionToken(rawPath, full)) {
    return { rawToken: rawPath, suffix: "" };
  }
  for (let i = rawPath.length - 1; i >= 12; i--) {
    const candidate = rawPath.slice(0, i);
    const decoded = tryDecodeNavionToken(candidate);
    if (!decoded || !decoded.endsWith("/")) continue;
    if (!isExactNavionToken(candidate, decoded)) continue;
    const suffix = rawPath.slice(i);
    if (!suffix) continue;
    return { rawToken: candidate, suffix };
  }
  return { rawToken: rawPath, suffix: "" };
}

export function applyNavionSuffix(target, suffix) {
  if (!suffix) return target;
  let piece = suffix;
  if (!piece.startsWith("/")) piece = `/${piece}`;
  const suffixUrl = new URL(piece, "https://navion.invalid");
  target.pathname = target.pathname.replace(/\/?$/, "") + suffixUrl.pathname;
  if (suffixUrl.search) target.search = suffixUrl.search;
  if (suffixUrl.hash) target.hash = suffixUrl.hash;
  return target;
}

export function parseNavionPath(pathname) {
  if (!pathname || !pathname.startsWith(PREFIX)) return null;
  const rawPath = pathname.slice(PREFIX.length);
  if (!rawPath) return null;
  const { rawToken, suffix } = splitNavionRawPath(rawPath);
  let token = rawToken;
  try { token = decodeURIComponent(rawToken); } catch {}
  let decoded = null;
  try {
    decoded = /^https?:\/\//i.test(token) ? token : decode(token);
  } catch {}
  if (!decoded || !/^https?:\/\//i.test(decoded)) return null;
  return { rawToken, suffix, decoded };
}

export function resolveNavionTarget(pathname, search = "", hash = "") {
  const parsed = parseNavionPath(pathname);
  if (!parsed) return null;
  const target = applyNavionSuffix(new URL(parsed.decoded), parsed.suffix);
  if (search && !target.search) target.search = search;
  if (hash) target.hash = hash;
  return target.href;
}

export function decodeNavionToken(pathname) {
  const parsed = parseNavionPath(pathname);
  return parsed?.decoded || null;
}

export function rewriteUrl(url, base) {
  if (!url) return url;
  const trimmed = url.trim();
  if (
    BYPASS_SCHEME_RE.test(trimmed) ||
    trimmed.startsWith("#") ||
    trimmed.toLowerCase().startsWith(PREFIX)
  ) {
    return url;
  }

  try {
    const resolved = base ? new URL(trimmed, base).href : new URL(trimmed).href;
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    if (base) {
      try {
        const baseUrl = new URL(base);
        if (NAVION_SHELL_PATHS.has(parsed.pathname)) return url;
        if (parsed.origin === baseUrl.origin) {
          return PREFIX + encode(parsed.origin + "/") + parsed.pathname + parsed.search + parsed.hash;
        }
      } catch {}
    }
    return PREFIX + encode(resolved);
  } catch {
    return url;
  }
}

export function unrewriteUrl(url) {
  if (!url || !url.startsWith(PREFIX)) return url;
  const parsed = parseNavionPath(url.split("?")[0].split("#")[0]);
  return parsed?.decoded || url;
}
