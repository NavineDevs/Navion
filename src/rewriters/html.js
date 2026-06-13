import { rewriteUrl } from "./url.js";
import { rewriteCss } from "./css.js";
import { rewriteJs } from "./js.js";

const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "data",
  "background", "ping", "manifest", "xlink:href", "profile",
  "longdesc", "cite", "usemap", "archive", "codebase", "classid",
  "data-src", "data-href", "data-url", "data-original", "data-lazy-src",
  "data-background", "data-bg", "data-poster", "data-iframe-src",
  "data-video", "data-file", "data-stream", "data-source", "data-mp4",
  "data-webm", "data-hls", "data-m3u8", "data-player", "data-embed",
  "data-id", "data-link", "data-target",
]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset", "data-srcset"]);
const EVENT_ATTR_RE = /^on[a-z][\w:-]*$/i;
const SANDBOX_TOKENS = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
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
  object: new Set(["data"]),
  embed: new Set(["src"]),
};

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

function rewriteMetaRefresh(value, base) {
  return String(value || "").replace(/(^|;)\s*url\s*=\s*([^;]+)/i, (m, pre, url) => {
    const trimmed = url.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
    return `${pre} url=${rewriteUrl(trimmed, base)}`;
  });
}

function rewriteSrcdoc(value, base) {
  return rewriteHtml(value, base, { injectRuntime: false, rewriteMode: "full" });
}

function normalizeSandboxValue(value) {
  const tokens = new Set(String(value || "").split(/\s+/).filter(Boolean));
  for (const token of SANDBOX_TOKENS) tokens.add(token);
  return Array.from(tokens).join(" ");
}

function processAttrs(attrs, base, tagName, rewriteMode) {
  const isNavOnly = rewriteMode === "nav-only";
  const allowed = isNavOnly ? NAV_ONLY_TAG_ATTRS[tagName] : null;
  let out = attrs.replace(
    /(\s+)([\w:-]+)(?:\s*=\s*(?:(["'])([\s\S]*?)\3|([^\s"'=<>`]+)))?/g,
    (m, sp, name, q, quotedVal, bareVal) => {
      const n = name.toLowerCase();
      const hasValue = quotedVal !== undefined || bareVal !== undefined;
      const val = quotedVal !== undefined ? quotedVal : bareVal;
      const eq = hasValue ? "=" : "";
      const quote = q || "";
      const wrap = (next) => hasValue ? sp + name + eq + (quote ? quote + next + quote : next) : sp + name;
      if (!hasValue) return m;
      if ((tagName === "iframe" || tagName === "frame") && n === "sandbox") {
        return wrap(normalizeSandboxValue(val));
      }
      if (!isNavOnly && n === "integrity") return "";
      if (n === "target" && /^_blank$/i.test(String(val || "").trim())) return wrap("_self");
      if (!isNavOnly && n === "style") return wrap(rewriteCss(val, base));
      if (!isNavOnly && EVENT_ATTR_RE.test(n)) return wrap(rewriteJs(val, base));
      if (!isNavOnly && n === "srcdoc") return wrap(rewriteSrcdoc(val, base));
      if (URL_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        return wrap(rewriteUrl(val.trim(), base));
      }
      if (SRCSET_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        return wrap(rewriteSrcset(val, base));
      }
      if (n === "content") {
        const refreshed = tagName === "meta" ? rewriteMetaRefresh(val, base) : val;
        if (refreshed !== val) return wrap(refreshed);
      }
      return m;
    }
  );
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

const YOUTUBE_FALLBACK = (base) =>
  `<script>!function(){var base=${JSON.stringify(base)};` +
  `function ign(e){try{var m=String(e&&e.message||e&&e.reason&&e.reason.message||e&&e.reason||"");return m.indexOf("playlistHandlerActionMap")!==-1||m.indexOf("LegacyDataMixin")!==-1||m.indexOf("_legacyUndefinedCheck")!==-1}catch(x){return false}}window.addEventListener("error",function(e){if(ign(e)){e.preventDefault();e.stopImmediatePropagation()}},true);window.addEventListener("unhandledrejection",function(e){if(ign(e)){e.preventDefault();e.stopImmediatePropagation()}},true);var oe=window.onerror;window.onerror=function(m,s,l,c,e){if(ign({message:m,reason:e}))return true;return oe?oe.apply(this,arguments):false};` +
  `function enc(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}}` +
  `function prox(u){try{var r=new URL(u,base),b=new URL(base);if(r.origin===b.origin)return"/nv/"+enc(r.origin+"/")+r.pathname+r.search+r.hash;return"/nv/"+enc(r.href)}catch(e){return u}}` +
  `function txt(o){if(!o)return"";if(typeof o==="string")return o;if(o.simpleText)return o.simpleText;if(o.text)return o.text;if(o.runs)return o.runs.map(function(r){return r.text||""}).join("");return""}` +
  `function best(t){try{var a=t&&t.thumbnails||[];return a.length?a[a.length-1].url:""}catch(e){return""}}` +
  `function data(){if(window.ytInitialData)return window.ytInitialData;var ss=document.scripts;for(var i=0;i<ss.length;i++){var s=ss[i].textContent||"",p=s.indexOf("ytInitialData");if(p<0)continue;var b=s.indexOf("{",p),d=0,q=0,e=false;for(var j=b;j<s.length;j++){var c=s[j];if(q){if(e)e=false;else if(c==="\\\\")e=true;else if(c===q)q=0}else if(c==="\\""||c==="'")q=c;else if(c==="{")d++;else if(c==="}"&&--d===0){try{return JSON.parse(s.slice(b,j+1))}catch(x){break}}}}return null}` +
  `function player(){if(window.ytInitialPlayerResponse)return window.ytInitialPlayerResponse;var ss=document.scripts;for(var i=0;i<ss.length;i++){var s=ss[i].textContent||"",p=s.indexOf("ytInitialPlayerResponse");if(p<0)continue;var b=s.indexOf("{",p),d=0,q=0,e=false;for(var j=b;j<s.length;j++){var c=s[j];if(q){if(e)e=false;else if(c==="\\\\")e=true;else if(c===q)q=0}else if(c==="\\""||c==="'")q=c;else if(c==="{")d++;else if(c==="}"&&--d===0){try{return JSON.parse(s.slice(b,j+1))}catch(x){break}}}}return null}` +
  `function walk(x,out){if(!x||out.length>40)return;if(Array.isArray(x)){for(var i=0;i<x.length;i++)walk(x[i],out);return}if(typeof x!=="object")return;if(x.videoRenderer){var v=x.videoRenderer,id=v.videoId;if(id)out.push({kind:"Video",title:txt(v.title),url:"https://www.youtube.com/watch?v="+id,img:best(v.thumbnail),meta:[txt(v.ownerText),txt(v.viewCountText),txt(v.publishedTimeText),txt(v.lengthText)].filter(Boolean).join(" • ")});return}if(x.playlistRenderer){var p=x.playlistRenderer,u=p.playlistId?"https://www.youtube.com/playlist?list="+p.playlistId:txt(p.navigationEndpoint&&p.navigationEndpoint.commandMetadata&&p.navigationEndpoint.commandMetadata.webCommandMetadata&&p.navigationEndpoint.commandMetadata.webCommandMetadata.url);out.push({kind:"Playlist",title:txt(p.title),url:u,img:best(p.thumbnails&&p.thumbnails[0]),meta:txt(p.videoCountText)});return}if(x.channelRenderer){var ch=x.channelRenderer,u=ch.navigationEndpoint&&ch.navigationEndpoint.commandMetadata&&ch.navigationEndpoint.commandMetadata.webCommandMetadata&&ch.navigationEndpoint.commandMetadata.webCommandMetadata.url||ch.canonicalBaseUrl;out.push({kind:"Channel",title:txt(ch.title),url:u,img:best(ch.thumbnail),meta:txt(ch.videoCountText)||txt(ch.subscriberCountText)});return}for(var k in x)walk(x[k],out)}` +
  `function esc(s){return String(s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}` +
  `function render(){try{if(document.body&&document.body.innerText.trim()&&document.querySelector("a#video-title,ytd-video-renderer,ytd-rich-item-renderer,video"))return;var d=data(),items=[];walk(d,items);var u=new URL(location.href),q=u.searchParams.get("search_query")||u.searchParams.get("q")||"",vid=u.searchParams.get("v")||"",rows="";if(items.length){rows=items.map(function(it){var img=it.img?'<img src="'+esc(prox(it.img))+'" alt="">':"<span></span>";return'<a class="nvyt-card" href="'+esc(prox(it.url))+'">'+img+'<span><b>'+esc(it.title)+'</b><small>'+esc(it.kind+(it.meta?" - "+it.meta:""))+'</small></span></a>'}).join("");document.title=q?q+" - YouTube":"YouTube"}else if(vid){var p=player(),vd=p&&p.videoDetails||{},th=vd.thumbnail&&vd.thumbnail.thumbnails||[],img=th.length?th[th.length-1].url:"https://i.ytimg.com/vi/"+vid+"/hqdefault.jpg",title=vd.title||document.title||"YouTube video",author=vd.author||"",views=vd.viewCount?Number(vd.viewCount).toLocaleString()+" views":"",stream="",fm=(p&&p.streamingData&&p.streamingData.formats||[]).concat(p&&p.streamingData&&p.streamingData.adaptiveFormats||[]);for(var si=0;si<fm.length;si++){var f=fm[si];if(f&&f.url&&/video\\/mp4/i.test(f.mimeType||"")){stream=f.url;if(f.audioQuality)break}}var media=stream?'<video controls playsinline poster="'+esc(prox(img))+'" src="'+esc(prox(stream))+'"></video>':'<img src="'+esc(prox(img))+'" alt="">';document.title=title+" - YouTube";rows='<section class="nvyt-watch">'+media+'<h1>'+esc(title)+'</h1><p>'+esc([author,views].filter(Boolean).join(" - "))+'</p><a class="nvyt-open" href="'+esc(prox("https://www.youtube.com/watch?v="+vid))+'">Reload video through Navion</a></section>'}else return;document.documentElement.innerHTML='<head><title>'+esc(document.title)+'</title><style>body{margin:0;background:#0f0f0f;color:#f1f1f1;font:14px Arial,Helvetica,sans-serif}.nvyt-top{position:sticky;top:0;background:#0f0f0f;border-bottom:1px solid #303030;padding:14px 18px;display:flex;gap:12px;align-items:center}.nvyt-logo{font-size:21px;font-weight:700;color:#fff;text-decoration:none}.nvyt-logo:before{content:"▶";color:#ff0033;margin-right:7px}.nvyt-search{flex:1;display:flex;max-width:760px}.nvyt-search input{flex:1;background:#121212;color:#fff;border:1px solid #3f3f3f;border-radius:22px 0 0 22px;padding:11px 16px;font-size:16px}.nvyt-search button{background:#272727;color:#fff;border:1px solid #3f3f3f;border-left:0;border-radius:0 22px 22px 0;padding:0 20px}.nvyt-main{max-width:1040px;margin:0 auto;padding:22px 18px 48px}.nvyt-card{display:grid;grid-template-columns:220px 1fr;gap:16px;color:#fff;text-decoration:none;padding:10px;border-radius:8px}.nvyt-card:hover{background:#202020}.nvyt-card img,.nvyt-card>span:first-child{width:220px;aspect-ratio:16/9;object-fit:cover;background:#242424;border-radius:8px}.nvyt-card b{display:block;font-size:18px;line-height:1.35;margin:4px 0 8px}.nvyt-card small{color:#aaa;line-height:1.4}.nvyt-watch video,.nvyt-watch img{width:100%;aspect-ratio:16/9;border:0;background:#000;border-radius:8px;object-fit:cover}.nvyt-watch h1{font-size:24px;line-height:1.3;margin:18px 0 8px}.nvyt-watch p{color:#aaa}.nvyt-open{display:inline-block;color:#3ea6ff;margin-top:10px}@media(max-width:650px){.nvyt-top{align-items:stretch;flex-direction:column}.nvyt-card{grid-template-columns:1fr}.nvyt-card img,.nvyt-card>span:first-child{width:100%}}</style></head><body><header class="nvyt-top"><a class="nvyt-logo" href="'+esc(prox("https://www.youtube.com/"))+'">YouTube</a><form class="nvyt-search"><input name="q" value="'+esc(q)+'" autocomplete="off"><button>Search</button></form></header><main class="nvyt-main">'+rows+'</main></body>';document.querySelector(".nvyt-search").addEventListener("submit",function(e){e.preventDefault();var v=this.q.value.trim();if(v)location.href=prox("https://www.youtube.com/results?search_query="+encodeURIComponent(v))})}catch(e){}}` +
  `setTimeout(render,900);setTimeout(render,2500);addEventListener("load",function(){setTimeout(render,300)},true)}` +
  `();</script>`;

const YOUTUBE_RECOVERY = (base) =>
  `<script>!function(){var base=${JSON.stringify(base)};` +
  `function ign(e){try{var m=String(e&&e.message||e&&e.reason&&e.reason.message||e&&e.reason||"");return m.indexOf("playlistHandlerActionMap")!==-1||m.indexOf("LegacyDataMixin")!==-1||m.indexOf("_legacyUndefinedCheck")!==-1}catch(x){return false}}window.addEventListener("error",function(e){if(ign(e)){e.preventDefault();e.stopImmediatePropagation()}},true);window.addEventListener("unhandledrejection",function(e){if(ign(e)){e.preventDefault();e.stopImmediatePropagation()}},true);var oe=window.onerror;window.onerror=function(m,s,l,c,e){if(ign({message:m,reason:e}))return true;return oe?oe.apply(this,arguments):false};` +
  `function enc(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}}` +
  `function prox(u){try{var r=new URL(u,base),b=new URL(base);if(r.origin===b.origin)return"/nv/"+enc(r.origin+"/")+r.pathname+r.search+r.hash;return"/nv/"+enc(r.href)}catch(e){return u}}` +
  `function esc(s){return String(s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}` +
  `function q(){try{return new URL(location.href)}catch(e){return new URL(base)}}` +
  `function b(){try{return new URL(base)}catch(e){return q()}}` +
  `function vid(s){try{return new URL(s).searchParams.get("v")||""}catch(e){var m=String(s||"").match(/[?&]v=([^&]+)/);return m?decodeURIComponent(m[1]):""}}` +
  `function sid(s){try{var m=new URL(s).pathname.match(/\\/shorts\\/([^/?#]+)/);return m?m[1]:""}catch(e){var x=String(s||"").match(/\\/shorts\\/([^/?#]+)/);return x?decodeURIComponent(x[1]):""}}` +
  `var saved=vid(base)||vid(location.href);try{if(saved)sessionStorage.setItem("nvyt-video",JSON.stringify({v:saved,t:Date.now()}))}catch(e){}` +
  `function savedVid(){try{var x=JSON.parse(sessionStorage.getItem("nvyt-video")||"null");return x&&x.v&&Date.now()-x.t<30000?x.v:""}catch(e){return""}}` +
  `function submit(e){e.preventDefault();var v=this.querySelector("input");v=v&&v.value.trim();if(v)location.href=prox("https://www.youtube.com/results?search_query="+encodeURIComponent(v))}` +
  `function render(){try{if(document.querySelector(".nvyt-shell"))return;var u=q(),bu=b(),v=vid(location.href)||vid(base)||sid(location.href)||sid(base)||u.searchParams.get("v")||bu.searchParams.get("v")||savedVid()||"",term=u.searchParams.get("search_query")||u.searchParams.get("q")||bu.searchParams.get("search_query")||bu.searchParams.get("q")||"",title=document.title&&document.title.replace(/ - YouTube$/,"")||"YouTube",main="";if(v){var src="https:"+"//www.youtube.com/embed/"+encodeURIComponent(v)+"?playsinline=1&rel=0";main='<section class="nvyt-player"><iframe src="'+esc(src)+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><h1>'+esc(title)+'</h1><a href="'+esc(prox("https://www.youtube.com/watch?v="+v))+'">Reload with full YouTube page</a></section>'}else{title=term?term+" - YouTube":"YouTube";main='<section class="nvyt-home"><h1>'+esc(term?("Search: "+term):"YouTube")+'</h1><p>Use the search box above. Navion keeps this page stable so YouTube refresh loops do not take over.</p></section>'}document.documentElement.innerHTML='<head><title>'+esc(title)+'</title><style>html,body{margin:0;min-height:100%;background:#0f0f0f;color:#f1f1f1;font:14px Arial,Helvetica,sans-serif}.nvyt-shell{min-height:100vh;display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:64px minmax(0,1fr)}.nvyt-top{grid-column:1/3;display:flex;align-items:center;gap:18px;border-bottom:1px solid #292929;background:#0f0f0f;padding:0 18px;position:sticky;top:0;z-index:2}.nvyt-logo{font-size:21px;font-weight:700;color:#fff;text-decoration:none;white-space:nowrap}.nvyt-logo:before{content:"▶";color:#ff0033;margin-right:8px}.nvyt-search{display:flex;flex:1;max-width:760px;margin:0 auto}.nvyt-search input{min-width:0;flex:1;background:#121212;color:#fff;border:1px solid #3f3f3f;border-radius:22px 0 0 22px;padding:11px 16px;font-size:16px}.nvyt-search button{background:#272727;color:#fff;border:1px solid #3f3f3f;border-left:0;border-radius:0 22px 22px 0;padding:0 20px}.nvyt-side{border-right:1px solid #202020;padding:12px;background:#0f0f0f}.nvyt-side a{display:flex;align-items:center;color:#f1f1f1;text-decoration:none;height:42px;border-radius:8px;padding:0 14px;font-size:15px}.nvyt-side a:hover{background:#272727}.nvyt-main{padding:22px;min-width:0}.nvyt-player,.nvyt-home{max-width:1120px;margin:0 auto}.nvyt-player iframe{display:block;width:100%;aspect-ratio:16/9;border:0;background:#000;border-radius:10px}.nvyt-player h1,.nvyt-home h1{font-size:22px;line-height:1.35;margin:16px 0 8px}.nvyt-player a{color:#3ea6ff}.nvyt-home p{color:#aaa;line-height:1.6}@media(max-width:780px){.nvyt-shell{grid-template-columns:1fr}.nvyt-top{grid-column:1}.nvyt-side{display:flex;gap:8px;overflow:auto;border-right:0;border-bottom:1px solid #202020}.nvyt-side a{white-space:nowrap}.nvyt-main{padding:14px}}</style></head><body><div class="nvyt-shell" data-video="'+esc(v)+'"><header class="nvyt-top"><a class="nvyt-logo" href="'+esc(prox("https://www.youtube.com/"))+'">YouTube</a><form class="nvyt-search"><input name="q" value="'+esc(term)+'" autocomplete="off" placeholder="Search"><button>Search</button></form></header><nav class="nvyt-side"><a href="'+esc(prox("https://www.youtube.com/"))+'">Home</a><a href="'+esc(prox("https://www.youtube.com/shorts/"))+'">Shorts</a><a href="'+esc(prox("https://www.youtube.com/feed/subscriptions"))+'">Subscriptions</a><a href="'+esc(prox("https://www.youtube.com/feed/history"))+'">History</a></nav><main class="nvyt-main">'+main+'</main></div></body>';var f=document.querySelector(".nvyt-search");if(f)f.addEventListener("submit",submit)}catch(e){}}` +
  `setTimeout(render,1800);setTimeout(render,4200);var n=0,t=setInterval(function(){render();if(++n>10||document.querySelector(".nvyt-shell"))clearInterval(t)},1200);addEventListener("load",function(){setTimeout(render,1200)},true)}` +
  `();</script>`;

const DARK_MODE_HINT = `<meta name="color-scheme" content="dark"><style id="nv-dark-mode">html{color-scheme:dark!important}body{color-scheme:dark!important}</style>`;

const YOUTUBE_HELPER = (base) =>
  `<script>!function(){var b=${JSON.stringify(base)};` +
  `function i(e){try{var m=String(e&&e.message||e&&e.reason&&e.reason.message||e&&e.reason||e||"");return m.indexOf("LegacyDataMixin")!==-1||m.indexOf("_legacyUndefinedCheck")!==-1||m.indexOf("playlistHandlerActionMap")!==-1}catch(x){return false}}window.addEventListener("error",function(e){if(i(e)){e.preventDefault();e.stopImmediatePropagation()}},true);window.addEventListener("unhandledrejection",function(e){if(i(e)){e.preventDefault();e.stopImmediatePropagation()}},true);try{var ow=console.warn,oe=console.error;console.warn=function(){if(i(Array.prototype.join.call(arguments," ")))return;return ow.apply(console,arguments)};console.error=function(){if(i(Array.prototype.join.call(arguments," ")))return;return oe.apply(console,arguments)}}catch(e){}` +
  `function n(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}}` +
  `function p(u){try{var r=new URL(u,b),o=new URL(b);if(r.origin===o.origin)return"/nv/"+n(r.origin+"/")+r.pathname+r.search+r.hash;return"/nv/"+n(r.href)}catch(e){return u}}` +
  `function u(x){try{if(x==null)return x;var t=String(x);if(!t||/^(javascript:|data:|blob:|#|\\/nv\\/|\\/api\\/|\\/app$|\\/nav\\/|\\/index\\.html|\\/nv\\.)/i.test(t))return x;var r=new URL(t,b);return p(r.href)}catch(e){return x}}` +
  `try{var hp=history.pushState,hr=history.replaceState;history.pushState=function(a,t,x){if(arguments.length>2)x=u(x);return hp.call(this,a,t,x)};history.replaceState=function(a,t,x){if(arguments.length>2)x=u(x);return hr.call(this,a,t,x)}}catch(e){}` +
  `function l(){try{if(location.pathname.indexOf("/nv/")===0)return;if(/^(\\/api\\/|\\/app$|\\/nav\\/|\\/index\\.html|\\/nv\\.)/.test(location.pathname))return;history.replaceState(history.state,document.title,u(location.pathname+location.search+location.hash))}catch(e){}}` +
  `function d(){try{document.documentElement.setAttribute("dark","");document.documentElement.setAttribute("data-theme","dark");document.documentElement.style.colorScheme="dark";if(document.body){document.body.setAttribute("dark","");document.body.style.colorScheme="dark"}var s=document.getElementById("nvyt-dark");if(!s&&document.head){s=document.createElement("style");s.id="nvyt-dark";s.textContent="html,body,ytd-app{color-scheme:dark!important;background:#0f0f0f!important}html[dark] ytd-app,html[dark] #page-manager,html[dark] ytd-page-manager{background:#0f0f0f!important}html,body{overscroll-behavior:none!important}";document.head.appendChild(s)}}catch(e){}}` +
  `function q(){var e=document.querySelector('input[name="search_query"],input#search,input[name="q"],yt-searchbox input');return e&&String(e.value||"").trim()}` +
  `function g(v){if(v)location.href=p("https://www.youtube.com/results?search_query="+encodeURIComponent(v))}` +
  `function r(e){var f=e.target;if(!f||!f.querySelector)return;var v=q();if(v&&f.querySelector('input[name="search_query"],input#search,input[name="q"],yt-searchbox input')){e.preventDefault();e.stopImmediatePropagation();g(v)}}` +
  `function c(e){var t=e.target&&e.target.closest&&e.target.closest('button#search-icon-legacy,button[aria-label="Search"],yt-searchbox button,ytd-searchbox button');if(!t)return;var v=q();if(v){e.preventDefault();e.stopImmediatePropagation();g(v)}}` +
  `function s(){try{return /\\/shorts(\\/|$)/.test(new URL(location.href).pathname)||/\\/shorts(\\/|$)/.test(new URL(b).pathname)}catch(e){return false}}` +
  `function z(e){if(!s())return;e.preventDefault();e.stopImmediatePropagation()}` +
  `d();l();setInterval(d,1200);setInterval(l,600);document.addEventListener("submit",r,true);document.addEventListener("click",c,true);addEventListener("load",function(){d();l()},true);addEventListener("popstate",l,true);addEventListener("wheel",z,{capture:true,passive:false});addEventListener("touchmove",z,{capture:true,passive:false});addEventListener("keydown",function(e){if([" ","PageDown","PageUp","ArrowDown","ArrowUp"].indexOf(e.key)!==-1)z(e)},true);` +
  `}();</script>`;

const INJECT = (base, mode) =>
  mode === "navianime" ? DARK_MODE_HINT + `<script>!function(){var b=${JSON.stringify(base)};function n(t){try{return btoa(encodeURIComponent(t)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return""}}function p(t){try{var r=new URL(t,b);if(r.origin===location.origin&&r.pathname.indexOf("/nv/")===0)return r.pathname+r.search+r.hash;return"/nv/"+n(r.origin+"/")+r.pathname+r.search+r.hash}catch(e){return t}}try{var u=new URL(b),h=u.pathname+u.search+u.hash;if(!h)h="/";if(location.pathname+location.search+location.hash!==h)history.replaceState(history.state,document.title,h)}catch(e){}function e(t){return String(t||"").replace(/[&<>"]/g,function(e){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[e]})}function s(){if(document.getElementById("nvna-style"))return;var c=document.createElement("style");c.id="nvna-style";c.textContent=".nvna{padding:32px;max-width:1180px;margin:0 auto}.nvna h1{font-size:32px;margin:0 0 6px}.nvna p{color:var(--muted-foreground,#8b92a6);margin:0 0 24px;line-height:1.6}.nvna-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:18px}.nvna-card{color:inherit;text-decoration:none;display:flex;flex-direction:column;gap:10px}.nvna-card img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:10px;background:#111827}.nvna-card b{display:block;font-size:14px;line-height:1.3}.nvna-card small{display:block;color:var(--muted-foreground,#8b92a6);font-size:12px;margin-top:4px}.nvna-detail{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:28px}.nvna-detail img{width:100%;border-radius:12px;background:#111827}.nvna-back{display:inline-block;margin:0 0 22px;color:#38bdf8;text-decoration:none}.nvna-meta{color:var(--muted-foreground,#8b92a6)}@media(max-width:720px){.nvna{padding:22px}.nvna-detail{grid-template-columns:1fr}}";document.head.appendChild(c)}document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("a[href],[data-href],[data-url]");if(!t)return;var r=t.getAttribute("href")||t.getAttribute("data-href")||t.getAttribute("data-url");if(!r||r.indexOf("#")===0||r.indexOf("javascript:")===0)return;try{var q=new URL(r,location.href);if(q.origin===location.origin&&q.pathname.indexOf("/nv/")===0){e.preventDefault();e.stopImmediatePropagation();location.assign(q.pathname+q.search+q.hash);return}}catch(x){}if(r.indexOf("/nv/")===0){e.preventDefault();e.stopImmediatePropagation();location.assign(r);return}e.preventDefault();e.stopImmediatePropagation();location.assign(p(r))},true);function r(){var t=document.body&&document.body.innerText||"";if((!/Loading anime/i.test(t)&&!/Discover your next favorite series/i.test(t))||document.querySelector(".nvna-card,a[href*='/anime/']"))return;fetch("https://api.jikan.moe/v4/anime?page=1&limit=24&sfw=false&order_by=score&sort=desc").then(function(e){return e.ok?e.json():null}).then(function(t){var n=t&&t.data||[];if(!n.length)return;var a=document.querySelector("main")||document.body,o=n.map(function(t){var n=t.images&&t.images.jpg&&((t.images.jpg.large_image_url)||t.images.jpg.image_url)||"",a=t.title_english||t.title||"Anime",i=t.score||"",s=t.type||"",l=t.episodes?String(t.episodes)+" Eps":"",h=p("/anime/"+encodeURIComponent(String(t.mal_id||"")));return'<a class="nvna-card" href="'+e(h)+'">'+(n?'<img src="'+e(n)+'" alt="'+e(a)+'">':"")+'<span><b>'+e(a)+'</b><small>'+e([i,s,l].filter(Boolean).join(" • "))+'</small></span></a>'}).join("");a.innerHTML='<section class="nvna"><div><h1>Browse Anime</h1><p>Discover your next favorite series</p></div><div class="nvna-grid">'+o+'</div></section>';s()}).catch(function(){})}function d(){var m=(new URL(b)).pathname.match(/\\/anime\\/(\\d+)/);if(!m)return;var t=document.body&&document.body.innerText||"";if(!/404|not found|could not be found/i.test(t)&&document.querySelector(".nvna-detail"))return;fetch("https://api.jikan.moe/v4/anime/"+m[1]+"/full").then(function(e){return e.ok?e.json():null}).then(function(t){var n=t&&t.data;if(!n)return;var a=document.querySelector("main")||document.body,o=n.images&&n.images.jpg&&((n.images.jpg.large_image_url)||n.images.jpg.image_url)||"",i=n.title_english||n.title||"Anime",l=[n.score?n.score+" score":"",n.type||"",n.episodes?String(n.episodes)+" Eps":"",n.status||""].filter(Boolean).join(" • "),y=n.synopsis||"No synopsis available.";a.innerHTML='<section class="nvna"><a class="nvna-back" href="'+e(p("/browse"))+'">Back to Browse</a><div class="nvna-detail">'+(o?'<img src="'+e(o)+'" alt="'+e(i)+'">':"")+'<div><h1>'+e(i)+'</h1><p class="nvna-meta">'+e(l)+'</p><p>'+e(y)+'</p></div></div></section>';document.title=i+" - NaviAnime";s()}).catch(function(){})}setTimeout(r,1200);setTimeout(r,3000);setTimeout(r,6500);setTimeout(d,1200);setTimeout(d,4000)}();</script>` :
  DARK_MODE_HINT + `<script>!function(){` +
  `try{window.open=function(u,t){if(typeof u==="string"&&/^_(?:self|top|parent)$/i.test(String(t||"")))location.assign(window.__navion&&window.__navion.rewrite?window.__navion.rewrite(u,window.__navion.base):u);return null}}catch(e){}` +
  `var _cw=console.warn,_ce=console.error,_cl=console.log;function _nf(a){try{var s=Array.prototype.join.call(a," ");return s.indexOf("The Chrome/Firefox/Safari extension cannot be detected on localhost")!==-1||s.indexOf("Navigator is not modified on localhost")!==-1||s.indexOf("Use ngrok to detect the extension")!==-1||s.indexOf("ChunkLoadError: Loading chunk")!==-1||s.indexOf("Loading chunk 2005 failed")!==-1||s.indexOf("useTranslation: SUBSCRIPTION_LINK_FOOTER is not available")!==-1||s.indexOf("working version is:")!==-1||s.indexOf("LegacyDataMixin will be applied to all legacy elements")!==-1||s.indexOf("_legacyUndefinedCheck: true")!==-1||s.indexOf("preloaded using link preload but not used")!==-1||s.indexOf("SES Removing unpermitted intrinsics")!==-1||s.indexOf("requestStorageAccessFor: Only supported")!==-1||s.indexOf("violates the following Content Security Policy directive")!==-1||s.indexOf("Refused to display")!==-1;}catch(e){return false}}console.warn=function(){if(_nf(arguments))return;return _cw.apply(console,arguments)};console.error=function(){if(_nf(arguments))return;return _ce.apply(console,arguments)};console.log=function(){if(_nf(arguments))return;return _cl.apply(console,arguments)};` +
  `var c=window.__navion={prefix:"/nv/",base:${JSON.stringify(base)},` +
  `mode:${JSON.stringify(mode || "full")},` +
  `encode:function(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}},` +
  `decode:function(e){try{var p=e+"=".repeat((4-e.length%4)%4);return decodeURIComponent(atob(p.replace(/-/g,"+").replace(/_/g,"/")))}catch(e){return e}},` +
  `rewrite:function(u,b){if(!u)return u;var t=String(u).trim();` +
  `if(/^(javascript:|data:|blob:|#|mailto:|tel:|about:|\\/nv\\/)/i.test(t))return u;` +
  `try{var e=new URL(t,location.href);if(e.origin===location.origin){if(e.pathname.startsWith("/nv/")||e.pathname==="/api/fetch"||e.pathname==="/api/navion-status"||e.pathname==="/favicon.ico"||e.pathname==="/generate_204"||e.pathname==="/nv.sw.js"||e.pathname==="/nv.client.js"||e.pathname==="/nv.register.js"||e.pathname==="/nav/home"||e.pathname==="/nav/error"||e.pathname==="/app"||e.pathname==="/index.html")return u;t=e.pathname+e.search+e.hash;}}catch(e){}` +
  `try{var r=b?new URL(t,b):new URL(t);if(b){try{var bb=new URL(b);if(r.origin===bb.origin)return"/nv/"+c.encode(r.origin+"/")+r.pathname+r.search+r.hash;}catch(e){}}return"/nv/"+c.encode(r.href)}catch(e){return u}}};` +
  `try{if(window.top!==window&&document.requestStorageAccessFor)Object.defineProperty(document,"requestStorageAccessFor",{configurable:true,value:function(){return Promise.resolve()}})}catch(e){}` +
  `var _po=location.origin;c._rl=window.location;` +
  `function _token(p){p=String(p||"");if(p.indexOf("/nv/")!==0)return"";var r=p.slice(4),s=r.indexOf("/"),t=s<0?r:r.slice(0,s),m=["dist/","_next/","country.json","duckchat/"];if(s<0){for(var i=0;i<m.length;i++){var x=r.indexOf(m[i]);if(x>0){t=r.slice(0,x);break}}}return t}` +
  `function _base(){try{var t=_token(location.pathname);if(t){var d=c.decode(t);if(/^https?:\\/\\//i.test(d))return d;}}catch(e){}return c.base;}` +
  `document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("a[href]");if(!el)return;var h=el.getAttribute("href");if(!h||h.startsWith("#")||h.startsWith("javascript:"))return;var p=c.rewrite(h,_base());if(p&&p!==h)el.setAttribute("href",p);},true);` +
  `document.addEventListener("submit",function(e){var f=e.target;if(!f||!f.action)return;var p=c.rewrite(f.action,_base());if(p&&p!==f.action)f.action=p;},true);` +
  `}();</script>` +
  (mode === "youtube" ? YOUTUBE_HELPER(base) : `<script src="/nv.client.js?v=4.2.47"></script>`);

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
