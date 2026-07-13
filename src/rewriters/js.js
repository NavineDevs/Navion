import { rewriteUrl } from "./url.js";

const PROXY_LITERAL_HOST_RE =
  /(?:googlevideo|gstatic|ytimg|ggpht|googleapis|doubleclick|youtube|phncdn|phprcdn|pornhub|trafficjunky|sb-cd|streamsb|doodcdn|doodstream|nhplayer|uncensoredhentai|vercel\.app|xvideos|xhamster|eporner|redtube|spankbang|xnxx|hstream\.moe|htstreaming|1hanime|hanime\.com|musume-h\.xyz|ane-h\.xyz|-h\.xyz)/i;

function shouldRewriteLiteral(value) {
  if (!value || value.includes("${")) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  try {
    const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!/^https?:\/\//i.test(normalized)) return PROXY_LITERAL_HOST_RE.test(raw);
    return PROXY_LITERAL_HOST_RE.test(new URL(normalized).hostname);
  } catch {
    return PROXY_LITERAL_HOST_RE.test(raw);
  }
}

function rewriteScriptUrlLiteral(url, base) {
  if (!url) return url;
  const value = String(url)
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003f/gi, "?")
    .replace(/\\x26/gi, "&")
    .trim();
  if (!value) return url;
  if (value.includes("${") || value.includes("}")) return url;
  if (/^[A-Z][A-Z0-9_-]*$/.test(value)) return url;
  if (!/^(?:https?:\/\/|\/\/|\/|\.{1,2}\/|\?|[\w.-]+\/)/i.test(value)) return url;
  return rewriteUrl(url, base);
}

function rewriteCallUrl(source, callee, base) {
  const escaped = callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w$.])(${escaped}\\s*\\(\\s*)(['"])([^'"]+)\\3`, "g");
  return source.replace(re, (m, lead, pre, q, value) => `${lead}${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`);
}

function rewriteConstructorUrl(source, name, base) {
  const re = new RegExp(`(^|[^\\w$.])(new\\s+${name}\\s*\\(\\s*)(['"])([^'"]+)\\3`, "g");
  return source.replace(re, (m, lead, pre, q, value) => `${lead}${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`);
}

function rewriteServiceWorkerRegister(source) {
  return source.replace(
    /(^|[^\w$.])(navigator\.serviceWorker\.register\s*\(\s*)(['"])([^'"]+)\3([^)]*\))/g,
    (m, lead) => `${lead}Promise.reject(new DOMException("Blocked by Navion proxy scope","SecurityError"))`
  );
}

export function rewriteJs(js, base) {
  if (!js) return js;

  let out = js;

  out = rewriteCallUrl(out, "importScripts", base);
  out = rewriteCallUrl(out, "fetch", base);
  out = rewriteCallUrl(out, "window.open", base);
  out = rewriteCallUrl(out, "location.assign", base);
  out = rewriteCallUrl(out, "location.replace", base);
  out = rewriteCallUrl(out, "window.location.assign", base);
  out = rewriteCallUrl(out, "window.location.replace", base);
  out = rewriteCallUrl(out, "self.location.assign", base);
  out = rewriteCallUrl(out, "self.location.replace", base);
  out = rewriteCallUrl(out, "globalThis.location.assign", base);
  out = rewriteCallUrl(out, "globalThis.location.replace", base);
  out = rewriteServiceWorkerRegister(out);
  out = rewriteConstructorUrl(out, "Worker", base);
  out = rewriteConstructorUrl(out, "SharedWorker", base);
  out = rewriteConstructorUrl(out, "EventSource", base);
  out = rewriteConstructorUrl(out, "WebSocket", base);

  out = out.replace(
    /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+|\/[^'"]+|https?:\/\/[^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(\bimport\s*)(['"])(\.{1,2}\/[^'"]+|\/[^'"]+|https?:\/\/[^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /((?:(?:window|self|globalThis)\.)?location\.href\s*=\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(\/\/#\s*sourceMappingURL=)([^\s]+)/g,
    (m, pre, value) => `${pre}${rewriteScriptUrlLiteral(value, base)}`
  );

  return rewriteMediaUrlLiterals(out, base);
}

export function rewriteMediaUrlLiterals(js, base) {
  if (!js) return js;
  let out = js;
  out = out.replace(
    /(["'`])(https?:\\\/\\\/[^"'`]+)\1/g,
    (m, q, value) => {
      const normalized = value.replace(/\\\//g, "/");
      if (!shouldRewriteLiteral(normalized)) return m;
      const rewritten = rewriteScriptUrlLiteral(normalized, base);
      if (rewritten === normalized) return m;
      return `${q}${rewritten.replace(/\//g, "\\/")}${q}`;
    }
  );
  out = out.replace(
    /(["'`])((?:https?:)?\/\/[^"'`\s]+)\1/g,
    (m, q, value) => {
      if (!shouldRewriteLiteral(value)) return m;
      const rewritten = rewriteScriptUrlLiteral(value, base);
      return rewritten === value ? m : `${q}${rewritten}${q}`;
    }
  );
  return out;
}

export function rewriteCdnUrlLiterals(js, base) {
  return rewriteMediaUrlLiterals(js, base);
}
