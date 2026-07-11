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

export function parseNavionPath(pathname) {
  if (!pathname || !pathname.startsWith(PREFIX)) return null;
  const rawPath = pathname.slice(PREFIX.length);
  if (!rawPath) return null;
  let slash = rawPath.indexOf("/");
  let rawToken = slash === -1 ? rawPath : rawPath.slice(0, slash);
  let suffix = slash === -1 ? "" : rawPath.slice(slash);
  if (!suffix) {
    for (const marker of PATH_MARKERS) {
      const index = rawPath.indexOf(marker);
      if (index > 0) {
        rawToken = rawPath.slice(0, index);
        suffix = `/${rawPath.slice(index)}`;
        break;
      }
    }
  }
  let token = rawToken;
  try { token = decodeURIComponent(rawToken); } catch {}
  let decoded = null;
  try {
    decoded = /^https?:\/\//i.test(token) ? token : decode(token);
  } catch {}
  if (!decoded || !/^https?:\/\//i.test(decoded)) return null;
  return { rawToken, suffix, decoded };
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
