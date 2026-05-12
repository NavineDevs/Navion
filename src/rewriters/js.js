import { rewriteUrl } from "./url.js";

function rewriteScriptUrlLiteral(url, base) {
  if (!url) return url;
  return rewriteUrl(url, base);
}

export function rewriteJs(js, base) {
  if (!js) return js;

  let out = js;

  // Ultraviolet-inspired targeted URL rewriting for worker and script loaders.
  out = out.replace(
    /(importScripts\s*\(\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(new\s+Worker\s*\(\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(new\s+SharedWorker\s*\(\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );
  out = out.replace(
    /(navigator\.serviceWorker\.register\s*\(\s*)(['"])([^'"]+)\2/g,
    (m, pre, q, value) => `${pre}${q}${rewriteScriptUrlLiteral(value, base)}${q}`
  );

  return out;
}
