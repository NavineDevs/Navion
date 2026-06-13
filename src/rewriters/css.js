import { rewriteUrl } from "./url.js";

function shouldSkipCssUrl(value) {
  return /^(?:data:|blob:|about:|#|var\(|env\()/i.test(String(value || "").trim());
}

function rewriteCssUrls(css, base) {
  let out = "";
  let i = 0;
  const lowerCss = css.toLowerCase();

  while (i < css.length) {
    const idx = lowerCss.indexOf("url(", i);
    if (idx === -1) {
      out += css.slice(i);
      break;
    }

    out += css.slice(i, idx);
    let pos = idx + 4;
    while (pos < css.length && /\s/.test(css[pos])) pos++;

    const quote = css[pos] === "\"" || css[pos] === "'" ? css[pos++] : "";
    let value = "";
    let closed = false;

    while (pos < css.length) {
      const ch = css[pos];
      if (quote) {
        if (ch === "\\" && pos + 1 < css.length) {
          value += ch + css[pos + 1];
          pos += 2;
          continue;
        }
        if (ch === quote) {
          pos++;
          closed = true;
          break;
        }
        value += ch;
        pos++;
        continue;
      }
      if (ch === ")") {
        closed = true;
        break;
      }
      value += ch;
      pos++;
    }

    if (!closed) {
      out += css.slice(idx);
      break;
    }

    while (pos < css.length && /\s/.test(css[pos])) pos++;
    if (css[pos] !== ")") {
      out += css.slice(idx, pos);
      i = pos;
      continue;
    }

    const cleanValue = value.trim();
    const rewritten = shouldSkipCssUrl(cleanValue) ? cleanValue : rewriteUrl(cleanValue, base);
    out += `url(${quote}${rewritten}${quote})`;
    i = pos + 1;
  }

  return out;
}

export function rewriteCss(css, base) {
  if (!css) return css;

  return rewriteCssUrls(css, base)
    .replace(/@import\s+url\(\s*(["']?)([^"')]+)\1\s*\)([^;}]*)/gi, (_, quote, url, rest) => {
      const cleanUrl = url.trim();
      const rewritten = shouldSkipCssUrl(cleanUrl) ? cleanUrl : rewriteUrl(cleanUrl, base);
      return `@import url(${quote || ""}${rewritten}${quote || ""})${rest || ""}`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, quote, url) => {
      const cleanUrl = url.trim();
      const rewritten = shouldSkipCssUrl(cleanUrl) ? cleanUrl : rewriteUrl(cleanUrl, base);
      return `@import ${quote}${rewritten}${quote}`;
    })
    .replace(/(\/\*#\s*sourceMappingURL=)([^*\s]+)(\s*\*\/)/gi, (_, pre, url, post) => {
      return `${pre}${rewriteUrl(url.trim(), base)}${post}`;
    })
    .replace(/(\/\/#\s*sourceMappingURL=)([^\s]+)/gi, (_, pre, url) => {
      return `${pre}${rewriteUrl(url.trim(), base)}`;
    });
}
