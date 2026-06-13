import { rewriteUrl } from "./url.js";

function rewriteScriptUrlLiteral(url, base) {
  if (!url) return url;
  const value = String(url).trim();
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
  out = rewriteCallUrl(out, "navigator.serviceWorker.register", base);
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
    /((?:window\.)?location\.href\s*=\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(\/\/#\s*sourceMappingURL=)([^\s]+)/g,
    (m, pre, value) => `${pre}${rewriteScriptUrlLiteral(value, base)}`
  );

  return out;
}
