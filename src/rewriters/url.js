export const PREFIX = "/nv/";

const BYPASS_SCHEME_RE = /^(?:javascript:|data:|blob:|mailto:|tel:|about:|chrome:|edge:|firefox:|opera:|brave:|file:|filesystem:)/i;
const LOCAL_PATHS = new Set([
  "/",
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
        if (parsed.origin === baseUrl.origin && LOCAL_PATHS.has(parsed.pathname)) return url;
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
  try {
    const raw = url.slice(PREFIX.length).split("?")[0].split("#")[0];
    return decode(raw);
  } catch {
    return url;
  }
}
