import { rewriteUrl } from "./url.js";

export function rewriteCss(css, base) {
  if (!css) return css;

  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, quote, url) => {
      return `url(${quote}${rewriteUrl(url.trim(), base)}${quote})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, quote, url) => {
      return `@import ${quote}${rewriteUrl(url, base)}${quote}`;
    })
    .replace(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, quote, url) => {
      return `@import url(${quote}${rewriteUrl(url.trim(), base)}${quote})`;
    });
}
