import { rewriteUrl } from "./url.js";
import { rewriteCss } from "./css.js";

const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "data",
  "background", "ping", "manifest", "xlink:href",
]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
const SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-downloads",
];
const NAV_ONLY_TAG_ATTRS = {
  a: new Set(["href", "ping"]),
  area: new Set(["href"]),
  link: new Set(["href"]),
  script: new Set(["src"]),
  form: new Set(["action"]),
  button: new Set(["formaction"]),
  img: new Set(["src", "srcset"]),
  source: new Set(["src", "srcset"]),
  video: new Set(["src", "poster"]),
  audio: new Set(["src"]),
  track: new Set(["src"]),
  iframe: new Set(["src"]),
  frame: new Set(["src"]),
};

function isPreloadAttrs(attrs) {
  return /\srel(?:\s*=\s*(?:"[^"]*\b(?:preload|modulepreload)\b[^"]*"|'[^']*\b(?:preload|modulepreload)\b[^']*'|[^\s"'=<>`]*\b(?:preload|modulepreload)\b[^\s"'=<>`]*))?/i.test(attrs);
}

function splitSrcsetEntries(srcset) {
  const entries = [];
  let buf = "";
  let parenDepth = 0;
  let inDataUrl = false;
  let dataCommaSeen = false;

  for (let i = 0; i < srcset.length; i++) {
    const ch = srcset[i];
    if (!buf.trim() && srcset.slice(i, i + 5).toLowerCase() === "data:") {
      inDataUrl = true;
      dataCommaSeen = false;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;

    if (inDataUrl) {
      if (ch === "," && !dataCommaSeen) {
        dataCommaSeen = true;
        buf += ch;
        continue;
      }
      if (dataCommaSeen && /\s/.test(ch)) inDataUrl = false;
    }

    if (ch === "," && parenDepth === 0 && !inDataUrl) {
      if (buf.trim()) entries.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) entries.push(buf.trim());
  return entries;
}

function rewriteSrcset(val, base) {
  return splitSrcsetEntries(val).map((part) => {
    const [url, ...descriptors] = part.split(/\s+/);
    if (!url || /^data:/i.test(url)) return part;
    const rewritten = rewriteUrl(url.trim(), base);
    return descriptors.length > 0
      ? `${rewritten} ${descriptors.join(" ")}`
      : rewritten;
  }).join(", ");
}

function normalizeSandboxValue(value) {
  const tokens = new Set(String(value || "").split(/\s+/).filter(Boolean));
  for (const token of SANDBOX_TOKENS) tokens.add(token);
  return Array.from(tokens).join(" ");
}

function processAttrs(attrs, base, tagName, rewriteMode) {
  const isNavOnly = rewriteMode === "nav-only";
  const allowed = isNavOnly ? NAV_ONLY_TAG_ATTRS[tagName] : null;
  const isPreloadLink = tagName === "link" && isPreloadAttrs(attrs);
  let hasCrossorigin = false;
  let out = attrs.replace(
    /(\s+)([\w:-]+)(\s*=\s*)(["'])([\s\S]*?)\4/g,
    (m, sp, name, eq, q, val) => {
      const n = name.toLowerCase();
      if (isPreloadLink && n === "crossorigin") {
        hasCrossorigin = true;
        return sp + name + eq + q + "use-credentials" + q;
      }
      if ((tagName === "iframe" || tagName === "frame") && n === "sandbox") {
        return sp + name + eq + q + normalizeSandboxValue(val) + q;
      }
      if (!isNavOnly && n === "integrity") return "";
      if (!isNavOnly && n === "style") return sp + name + eq + q + rewriteCss(val, base) + q;
      if (URL_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        return sp + name + eq + q + rewriteUrl(val.trim(), base) + q;
      }
      if (SRCSET_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        return sp + name + eq + q + rewriteSrcset(val, base) + q;
      }
      if (n === "content") {
        const refreshed = val.replace(/^(\d[^;]*;\s*url\s*=\s*)(\S+)/i, (_, pre, url) => pre + rewriteUrl(url, base));
        if (refreshed !== val) return sp + name + eq + q + refreshed + q;
      }
      return m;
    }
  );
  if (isPreloadLink && !hasCrossorigin) out += ` crossorigin="use-credentials"`;
  if (tagName === "iframe" || tagName === "frame") {
    out = out.replace(/(\s+sandbox\s*=\s*)([^\s"'=<>`]+)/i, (m, pre, val) => {
      return pre + `"${normalizeSandboxValue(val)}"`;
    });
    out = out.replace(/(\s+)sandbox(?=\s|$)/i, (m, sp) => {
      return sp + `sandbox="${normalizeSandboxValue("")}"`;
    });
  }
  return out;
}

function findTagEnd(html, from) {
  let q = 0;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (q) { if (c === q) q = 0; }
    else if (c === 34 || c === 39) { q = c; }
    else if (c === 62) return i;
  }
  return -1;
}

const INJECT = (base, mode) =>
  `<script>!function(){` +
  `var _cw=console.warn,_ce=console.error,_cl=console.log;function _nf(a){try{var s=Array.prototype.join.call(a," ");return s.indexOf("The Chrome/Firefox/Safari extension cannot be detected on localhost")!==-1||s.indexOf("Navigator is not modified on localhost")!==-1||s.indexOf("Use ngrok to detect the extension")!==-1||s.indexOf("ChunkLoadError: Loading chunk")!==-1||s.indexOf("Loading chunk 2005 failed")!==-1||s.indexOf("useTranslation: SUBSCRIPTION_LINK_FOOTER is not available")!==-1||s.indexOf("working version is:")!==-1||s.indexOf("LegacyDataMixin will be applied to all legacy elements")!==-1||s.indexOf("_legacyUndefinedCheck: true")!==-1||s.indexOf("preloaded using link preload but not used")!==-1||s.indexOf("SES Removing unpermitted intrinsics")!==-1||s.indexOf("requestStorageAccessFor: Only supported")!==-1||s.indexOf("violates the following Content Security Policy directive")!==-1||s.indexOf("Refused to display")!==-1;}catch(e){return false}}console.warn=function(){if(_nf(arguments))return;return _cw.apply(console,arguments)};console.error=function(){if(_nf(arguments))return;return _ce.apply(console,arguments)};console.log=function(){if(_nf(arguments))return;return _cl.apply(console,arguments)};` +
  `var c=window.__navion={prefix:"/nv/",base:${JSON.stringify(base)},` +
  `mode:${JSON.stringify(mode || "full")},` +
  `encode:function(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}},` +
  `decode:function(e){try{var p=e+"=".repeat((4-e.length%4)%4);return decodeURIComponent(atob(p.replace(/-/g,"+").replace(/_/g,"/")))}catch(e){return e}},` +
  `rewrite:function(u,b){if(!u)return u;var t=String(u).trim();` +
  `if(/^(javascript:|data:|blob:|#|mailto:|tel:|about:|\\/nv\\/)/i.test(t))return u;` +
  `try{var e=new URL(t,location.href);if(e.origin===location.origin&&(e.pathname.startsWith("/nv/")||e.pathname==="/api/fetch"||e.pathname==="/nv.sw.js"||e.pathname==="/nv.client.js"||e.pathname==="/nv.register.js"||e.pathname==="/nav/home"||e.pathname==="/nav/error"||e.pathname==="/app"))return u;}catch(e){}` +
  `try{var r=b?new URL(t,b).href:new URL(t).href;return"/nv/"+c.encode(r)}catch(e){return u}}};` +
  `try{if(window.top!==window&&document.requestStorageAccessFor)Object.defineProperty(document,"requestStorageAccessFor",{configurable:true,value:function(){return Promise.resolve()}})}catch(e){}` +
  `var _po=location.origin;c._rl=window.location;` +
  `function _token(p){p=String(p||"");if(p.indexOf("/nv/")!==0)return"";var r=p.slice(4),s=r.indexOf("/"),t=s<0?r:r.slice(0,s),m=["dist/","_next/","country.json","duckchat/"];if(s<0){for(var i=0;i<m.length;i++){var x=r.indexOf(m[i]);if(x>0){t=r.slice(0,x);break}}}return t}` +
  `function _base(){try{var t=_token(location.pathname);if(t){var d=c.decode(t);if(/^https?:\\/\\//i.test(d))return d;}}catch(e){}return c.base;}` +
  `document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("a[href]");if(!el)return;var h=el.getAttribute("href");if(!h||h.startsWith("#")||h.startsWith("javascript:"))return;var p=c.rewrite(h,_base());if(p&&p!==h)el.setAttribute("href",p);},true);` +
  `document.addEventListener("submit",function(e){var f=e.target;if(!f||!f.action)return;var p=c.rewrite(f.action,_base());if(p&&p!==f.action)f.action=p;},true);` +
  `}();</script>` +
  `<script src="/nv.client.js?v=4.2.13"></script>`;

export function rewriteHtml(html, base, options = {}) {
  const injectRuntime = options.injectRuntime !== false;
  const runtimeMode = options.runtimeMode || "full";
  const rewriteMode = options.rewriteMode || "full";
  const out = [];
  let i = 0;
  let inScript = false;
  let inStyle = false;
  let styleBuf = "";
  let injected = false;

  while (i < html.length) {
    if (html.charCodeAt(i) !== 60) {
      const next = html.indexOf("<", i);
      if (next === -1) {
        (inStyle ? (styleBuf += html.slice(i)) : out.push(html.slice(i)));
        break;
      }
      inStyle ? (styleBuf += html.slice(i, next)) : out.push(html.slice(i, next));
      i = next;
      continue;
    }

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) { out.push(html.slice(i)); break; }
      out.push(html.slice(i, end + 3));
      i = end + 3;
      continue;
    }

    if (html.charCodeAt(i + 1) === 33) {
      const end = html.indexOf(">", i + 2);
      if (end === -1) { out.push(html.slice(i)); break; }
      out.push(html.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, i + 1);
    if (tagEnd === -1) { out.push(html.slice(i)); break; }

    const inner = html.slice(i + 1, tagEnd);
    const nm = inner.match(/^(\/?)([\w-]+)/);
    const tag = nm?.[2]?.toLowerCase() ?? "";
    const isClose = nm?.[1] === "/";

    if (inScript) {
      if (isClose && tag === "script") { inScript = false; out.push("</script>"); }
      else out.push(html.slice(i, tagEnd + 1));
      i = tagEnd + 1;
      continue;
    }

    if (inStyle) {
      if (isClose && tag === "style") {
        inStyle = false;
        out.push(rewriteCss(styleBuf, base));
        styleBuf = "";
        out.push("</style>");
      } else {
        styleBuf += html.slice(i, tagEnd + 1);
      }
      i = tagEnd + 1;
      continue;
    }

    if (isClose) {
      if (injectRuntime && !injected && tag === "head") { out.push(INJECT(base, runtimeMode)); injected = true; }
      out.push(`</${tag}>`);
      i = tagEnd + 1;
      continue;
    }

    if (tag === "meta") {
      if (/content-security-policy/i.test(inner)) { i = tagEnd + 1; continue; }
    }

    if (tag === "base") {
      const m = inner.match(/\shref\s*=\s*(["'])([^"']*)\1/i);
      if (m) try { base = new URL(m[2], base).href; } catch {}
    }

    const attrStr = inner.slice(nm?.[0]?.length ?? 0);
    const selfClose = /\/\s*$/.test(attrStr);
    const attrs = processAttrs(attrStr.replace(/\/\s*$/, ""), base, tag, rewriteMode);
    out.push(`<${tag}${attrs}${selfClose ? " /" : ""}>`);

    if (injectRuntime && tag === "head" && !injected) { out.push(INJECT(base, runtimeMode)); injected = true; }
    if (tag === "script") inScript = true;
    if (tag === "style") inStyle = true;

    i = tagEnd + 1;
  }

  if (injectRuntime && !injected) out.unshift(INJECT(base, runtimeMode));
  return out.join("");
}
