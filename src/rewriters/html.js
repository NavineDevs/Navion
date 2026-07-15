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
      if ((tagName === "iframe" || tagName === "frame") && n === "sandbox") return "";
      if (!hasValue) return m;
      if (!isNavOnly && n === "integrity") return "";
      if (n === "target" && /^_blank$/i.test(String(val || "").trim())) return wrap("_self");
      if (!isNavOnly && n === "style") return wrap(rewriteCss(val, base));
      if (!isNavOnly && EVENT_ATTR_RE.test(n)) return wrap(rewriteJs(val, base));
      if (!isNavOnly && n === "srcdoc") return wrap(rewriteSrcdoc(val, base));
      if (URL_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        if (isLocalNavionUrl(val)) return m;
        return wrap(rewriteUrl(val.trim(), base));
      }
      if (SRCSET_ATTRS.has(n)) {
        if (isNavOnly && (!allowed || !allowed.has(n))) return m;
        if (isLocalNavionUrl(val)) return m;
        return wrap(rewriteSrcset(val, base));
      }
      if (n === "content") {
        const refreshed = tagName === "meta" ? rewriteMetaRefresh(val, base) : val;
        if (refreshed !== val) return wrap(refreshed);
      }
      return m;
    }
  );
  if (tagName === "iframe" || tagName === "frame") out = out.replace(/\s+sandbox(?:\s*=\s*(?:(["'])[\s\S]*?\1|[^\s"'=<>`]+))?/gi, "");
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

const RUNTIME_VERSION = "1.0.37";

const PROXY_MEDIA_HOST_RE =
  /(?:googlevideo|gstatic|ytimg|ggpht|googleapis|doubleclick|youtube|phncdn|phprcdn|pornhub|trafficjunky|sb-cd|streamsb|doodcdn|doodstream|nhplayer|uncensoredhentai|vercel\.app|xvideos|xhamster|eporner|redtube|spankbang|xnxx|hstream\.moe|htstreaming|1hanime|hanime\.com|musume-h\.xyz|ane-h\.xyz|-h\.xyz)/i;

function needsProxyMediaHost(hostname) {
  return PROXY_MEDIA_HOST_RE.test(String(hostname || "").toLowerCase());
}

function isLocalNavionUrl(value) {
  return /^(?:\/(?:nv\.client\.js|nv\.register\.js|nv\.sw\.js|favicon\.ico|generate_204|app|index\.html|nav\/|api\/(?:fetch|navion-status|jikan)(?:[/?#]|$))|#|javascript:|data:|blob:|mailto:|tel:|about:)/i.test(String(value || "").trim());
}

const NETWORK_PATCH = (base) =>
  `<script>!function(){var b=${JSON.stringify(base)};` +
  `function n(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}}` +
  `function x(h){h=String(h||"").toLowerCase();return (${PROXY_MEDIA_HOST_RE.toString()}).test(h)}` +
  `function p(u){try{var r=new URL(u,b);if(typeof location!=="undefined"&&r.origin===location.origin&&r.pathname.indexOf("/nv/")===0)return r.pathname+r.search+r.hash;var o=new URL(b);if(r.origin===o.origin)return"/nv/"+n(r.origin+"/")+r.pathname+r.search+r.hash;return"/nv/"+n(r.href)}catch(e){return u}}` +
  `function u(v){try{if(v==null)return v;var t=String(v);if(!t||/^(javascript:|data:|blob:|#|\\/nv\\/|\\/api\\/(?:fetch|navion-status|jikan)(?:[/?#]|$)|\\/app$|\\/nav\\/|\\/index\\.html|\\/nv\\.)/i.test(t))return v;var r=new URL(t,b);if(x(r.hostname))return p(r.href);if(r.origin===location.origin){if(/^\\/(?:nv\\/|api\\/(?:fetch|navion-status|jikan)(?:[/?#]|$)|app$|nav\\/|index\\.html|nv\\.)/.test(r.pathname))return r.pathname+r.search+r.hash;return p((new URL(r.pathname+r.search+r.hash,b)).href)}return p(r.href)}catch(e){return v}}` +
  `function k(v){try{if(v==null)return v;if(typeof v==="string"){if(/^\\/nv\\//i.test(v))return v;return u(v)}if(v&&typeof v.url==="string"){if(/^\\/nv\\//i.test(v.url))return v;var w=u(v.url);return w!==v.url?new Request(w,v):v}return v}catch(e){return v}}` +
  `try{var _pf=fetch;fetch=function(i,o){return _pf.call(this,k(i),o)}}catch(e){}` +
  `try{var _pxo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);if(typeof a[1]==="string")a[1]=u(a[1]);return _pxo.apply(this,a)}}catch(e){}` +
  `try{var _pr=window.Request;window.Request=function(i,o){return new _pr(k(i),o)}}catch(e){}` +
  `try{var _psb=navigator.sendBeacon;navigator.sendBeacon=function(t,d){if(typeof t==="string")t=u(t);return _psb.call(this,t,d)}}catch(e){}` +
  `try{var _ni=window.Image;window.Image=function(){var a=arguments,i=new _ni(a[0],a[1]);if(typeof a[0]==="string")i.src=u(a[0]);return i};window.Image.prototype=_ni.prototype}catch(e){}` +
  `try{function _ps(proto,prop){if(!proto)return;var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||typeof d.set!=="function")return;Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){if(typeof v==="string")v=u(v);return d.set.call(this,v)}})}_ps(HTMLImageElement&&HTMLImageElement.prototype,"src");_ps(HTMLVideoElement&&HTMLVideoElement.prototype,"src");_ps(HTMLAudioElement&&HTMLAudioElement.prototype,"src");_ps(HTMLSourceElement&&HTMLSourceElement.prototype,"src");_ps(HTMLScriptElement&&HTMLScriptElement.prototype,"src");_ps(HTMLIFrameElement&&HTMLIFrameElement.prototype,"src");_ps(HTMLLinkElement&&HTMLLinkElement.prototype,"href");_ps(HTMLAnchorElement&&HTMLAnchorElement.prototype,"href");_ps(HTMLFormElement&&HTMLFormElement.prototype,"action");var _sa=Element&&Element.prototype&&Element.prototype.setAttribute;if(_sa)Element.prototype.setAttribute=function(n,v){try{var k=String(n||"").toLowerCase();if(typeof v==="string"&&/^(src|href|action|poster|data|srcset|formaction|xlink:href)$/.test(k))v=u(v)}catch(e){}return _sa.call(this,n,v)}}catch(e){}` +
  `}();</script>`;

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
  `function render(){try{if(document.querySelector(".nvyt-shell"))return;var u=q(),bu=b(),v=vid(location.href)||vid(base)||sid(location.href)||sid(base)||u.searchParams.get("v")||bu.searchParams.get("v")||savedVid()||"",term=u.searchParams.get("search_query")||u.searchParams.get("q")||bu.searchParams.get("search_query")||bu.searchParams.get("q")||"",title=document.title&&document.title.replace(/ - YouTube$/,"")||"YouTube",main="";if(v){var src=prox("https://www.youtube.com/embed/"+encodeURIComponent(v)+"?playsinline=1&rel=0&autoplay=1");main='<section class="nvyt-player"><iframe src="'+esc(src)+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><h1>'+esc(title)+'</h1><a href="'+esc(prox("https://www.youtube.com/watch?v="+v))+'">Reload with full YouTube page</a></section>'}else{title=term?term+" - YouTube":"YouTube";main='<section class="nvyt-home"><h1>'+esc(term?("Search: "+term):"YouTube")+'</h1><p>Use the search box above. Navion keeps this page stable so YouTube refresh loops do not take over.</p></section>'}document.documentElement.innerHTML='<head><title>'+esc(title)+'</title><style>html,body{margin:0;min-height:100%;background:#0f0f0f;color:#f1f1f1;font:14px Arial,Helvetica,sans-serif}.nvyt-shell{min-height:100vh;display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-rows:64px minmax(0,1fr)}.nvyt-top{grid-column:1/3;display:flex;align-items:center;gap:18px;border-bottom:1px solid #292929;background:#0f0f0f;padding:0 18px;position:sticky;top:0;z-index:2}.nvyt-logo{font-size:21px;font-weight:700;color:#fff;text-decoration:none;white-space:nowrap}.nvyt-logo:before{content:"▶";color:#ff0033;margin-right:8px}.nvyt-search{display:flex;flex:1;max-width:760px;margin:0 auto}.nvyt-search input{min-width:0;flex:1;background:#121212;color:#fff;border:1px solid #3f3f3f;border-radius:22px 0 0 22px;padding:11px 16px;font-size:16px}.nvyt-search button{background:#272727;color:#fff;border:1px solid #3f3f3f;border-left:0;border-radius:0 22px 22px 0;padding:0 20px}.nvyt-side{border-right:1px solid #202020;padding:12px;background:#0f0f0f}.nvyt-side a{display:flex;align-items:center;color:#f1f1f1;text-decoration:none;height:42px;border-radius:8px;padding:0 14px;font-size:15px}.nvyt-side a:hover{background:#272727}.nvyt-main{padding:22px;min-width:0}.nvyt-player,.nvyt-home{max-width:1120px;margin:0 auto}.nvyt-player iframe{display:block;width:100%;aspect-ratio:16/9;border:0;background:#000;border-radius:10px}.nvyt-player h1,.nvyt-home h1{font-size:22px;line-height:1.35;margin:16px 0 8px}.nvyt-player a{color:#3ea6ff}.nvyt-home p{color:#aaa;line-height:1.6}@media(max-width:780px){.nvyt-shell{grid-template-columns:1fr}.nvyt-top{grid-column:1}.nvyt-side{display:flex;gap:8px;overflow:auto;border-right:0;border-bottom:1px solid #202020}.nvyt-side a{white-space:nowrap}.nvyt-main{padding:14px}}</style></head><body><div class="nvyt-shell" data-video="'+esc(v)+'"><header class="nvyt-top"><a class="nvyt-logo" href="'+esc(prox("https://www.youtube.com/"))+'">YouTube</a><form class="nvyt-search"><input name="q" value="'+esc(term)+'" autocomplete="off" placeholder="Search"><button>Search</button></form></header><nav class="nvyt-side"><a href="'+esc(prox("https://www.youtube.com/"))+'">Home</a><a href="'+esc(prox("https://www.youtube.com/shorts/"))+'">Shorts</a><a href="'+esc(prox("https://www.youtube.com/feed/subscriptions"))+'">Subscriptions</a><a href="'+esc(prox("https://www.youtube.com/feed/history"))+'">History</a></nav><main class="nvyt-main">'+main+'</main></div></body>';var f=document.querySelector(".nvyt-search");if(f)f.addEventListener("submit",submit)}catch(e){}}` +
  `render();setTimeout(render,1800);setTimeout(render,4200);var n=0,t=setInterval(function(){render();if(++n>10||document.querySelector(".nvyt-shell"))clearInterval(t)},1200);addEventListener("load",function(){setTimeout(render,1200)},true)}` +
  `();</script>`;

const DARK_MODE_HINT = `<meta name="color-scheme" content="dark"><style id="nv-dark-mode">html,body{color-scheme:dark!important;background:#0f0f0f!important}html[data-navion-dark] body,html[data-navion-dark] ytd-app,html[data-navion-dark] #page-manager,html[data-navion-dark] ytd-page-manager{background:#0f0f0f!important;color:#f1f1f1!important}html[data-navion-dark] :is(input,textarea,select,button){color-scheme:dark!important}html[data-navion-dark] :not(img):not(video):not(canvas):not(svg):not(path):not(use){border-color:#303030!important}html[data-navion-dark] [class*="skeleton"],html[data-navion-dark] [class*="placeholder"],html[data-navion-dark] [class*="shimmer"]{background-color:#242424!important;color:#f1f1f1!important}</style>`;
const DARK_MODE_SCRIPT =
  `<script>!function(){` +
  `function a(){try{var d=document.documentElement;d.setAttribute("data-navion-dark","");d.setAttribute("data-theme","dark");d.setAttribute("data-color-mode","dark");d.setAttribute("data-bs-theme","dark");d.classList.add("dark","theme-dark","nv-force-dark");d.style.colorScheme="dark";if(document.body){document.body.setAttribute("data-theme","dark");document.body.classList.add("dark","theme-dark","nv-force-dark");document.body.style.colorScheme="dark"}}catch(e){}}` +
  `function s(k,v){try{localStorage.setItem(k,v)}catch(e){}try{sessionStorage.setItem(k,v)}catch(e){}}["theme","color-theme","colorMode","color-mode","preferred-theme","preferredTheme","darkMode","mode"].forEach(function(k){s(k,"dark")});` +
  `try{var m=window.matchMedia;window.matchMedia=function(q){var r=m.call(this,q);try{if(/prefers-color-scheme\\s*:\\s*dark/i.test(String(q)))Object.defineProperty(r,"matches",{configurable:true,value:true});if(/prefers-color-scheme\\s*:\\s*light/i.test(String(q)))Object.defineProperty(r,"matches",{configurable:true,value:false})}catch(e){}return r}}catch(e){}` +
  `a();document.addEventListener("DOMContentLoaded",a,true);setInterval(a,1500);` +
  `}();</script>`;

const YOUTUBE_HELPER = (base) =>
  `<script>!function(){var b=${JSON.stringify(base)};` +
  `function i(e){try{var m=String(e&&e.message||e&&e.reason&&e.reason.message||e&&e.reason||e||"");return m.indexOf("LegacyDataMixin")!==-1||m.indexOf("_legacyUndefinedCheck")!==-1||m.indexOf("playlistHandlerActionMap")!==-1}catch(x){return false}}window.addEventListener("error",function(e){if(i(e)){e.preventDefault();e.stopImmediatePropagation()}},true);window.addEventListener("unhandledrejection",function(e){if(i(e)){e.preventDefault();e.stopImmediatePropagation()}},true);try{var ow=console.warn,oe=console.error;console.warn=function(){if(i(Array.prototype.join.call(arguments," ")))return;return ow.apply(console,arguments)};console.error=function(){if(i(Array.prototype.join.call(arguments," ")))return;return oe.apply(console,arguments)}}catch(e){}` +
  `function n(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}}` +
  `function p(u){try{var r=new URL(u,b);if(typeof location!=="undefined"&&r.origin===location.origin&&r.pathname.indexOf("/nv/")===0)return r.pathname+r.search+r.hash;var o=new URL(b);if(r.origin===o.origin)return"/nv/"+n(r.origin+"/")+r.pathname+r.search+r.hash;return"/nv/"+n(r.href)}catch(e){return u}}` +
  `function u(x){try{if(x==null)return x;var t=String(x);if(!t||/^(javascript:|data:|blob:|#|\\/nv\\/|\\/api\\/(?:fetch|navion-status|jikan)(?:[/?#]|$)|\\/app$|\\/nav\\/|\\/index\\.html|\\/nv\\.)/i.test(t))return x;var r=new URL(t,b);return p(r.href)}catch(e){return x}}` +
  `function k(x){try{if(x==null)return x;if(typeof x==="string"){if(/^\\/nv\\//i.test(x))return x;return u(x)}if(x&&typeof x.url==="string"){if(/^\\/nv\\//i.test(x.url))return x;var v=u(x.url);return v!==x.url?new Request(v,x):x}return x}catch(e){return x}}` +
  `try{var _vi=HTMLVideoElement.prototype,_ai=HTMLAudioElement.prototype,_si=HTMLSourceElement.prototype;function _ps(proto,prop){if(!proto)return;var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||typeof d.set!=="function")return;Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){if(typeof v==="string")v=u(v);return d.set.call(this,v)}})}_ps(_vi,"src");_ps(_ai,"src");_ps(_si,"src")}catch(e){}` +
  `function d(){try{document.documentElement.setAttribute("dark","");document.documentElement.setAttribute("data-theme","dark");document.documentElement.style.colorScheme="dark";if(document.body){document.body.setAttribute("dark","");document.body.style.colorScheme="dark"}var s=document.getElementById("nvyt-dark");if(!s&&document.head){s=document.createElement("style");s.id="nvyt-dark";s.textContent="html,body,ytd-app{color-scheme:dark!important;background:#0f0f0f!important}html[dark] ytd-app,html[dark] #page-manager,html[dark] ytd-page-manager{background:#0f0f0f!important}html,body{overscroll-behavior:none!important}";document.head.appendChild(s)}}catch(e){}}` +
  `function q(){var e=document.querySelector('input[name="search_query"],input#search,input[name="q"],yt-searchbox input');return e&&String(e.value||"").trim()}` +
  `function g(v){if(v)location.href=p("https://www.youtube.com/results?search_query="+encodeURIComponent(v))}` +
  `function r(e){var f=e.target;if(!f||!f.querySelector)return;var v=q();if(v&&f.querySelector('input[name="search_query"],input#search,input[name="q"],yt-searchbox input')){e.preventDefault();e.stopImmediatePropagation();g(v)}}` +
  `function c(e){var t=e.target&&e.target.closest&&e.target.closest('button#search-icon-legacy,button[aria-label="Search"],yt-searchbox button,ytd-searchbox button');if(!t)return;var v=q();if(v){e.preventDefault();e.stopImmediatePropagation();g(v)}}` +
  `function y(e){if(e.key!=="Enter")return;var t=e.target;if(!t||!t.matches||!t.matches('input[name="search_query"],input#search,input[name="q"],yt-searchbox input'))return;var v=String(t.value||"").trim();if(v){e.preventDefault();e.stopImmediatePropagation();g(v)}}` +
  `function s(){try{return /\\/shorts(\\/|$)/.test(new URL(location.href).pathname)||/\\/shorts(\\/|$)/.test(new URL(b).pathname)}catch(e){return false}}` +
  `function z(e){if(!s())return;e.preventDefault();e.stopImmediatePropagation()}` +
  `function vid(){try{var u=new URL(location.href),x=u.searchParams.get("v");if(x)return x;x=new URL(b).searchParams.get("v");if(x)return x;x=(u.pathname.match(/\\/shorts\\/([^/?#]+)/)||[])[1];if(x)return x;return(window.ytInitialPlayerResponse&&window.ytInitialPlayerResponse.videoDetails&&window.ytInitialPlayerResponse.videoDetails.videoId)||""}catch(e){return""}}` +
  `function esc(s){return String(s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}` +
  `var nvPlaybackFailed=false;function showEmbed(){if(nvPlaybackFailed||document.getElementById("nvyt-embed-fallback"))return;var v=vid();if(!v)return;nvPlaybackFailed=true;var box=document.createElement("div");box.id="nvyt-embed-fallback";box.style.cssText="position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.92);display:grid;place-items:center;padding:20px";box.innerHTML='<div style="width:min(960px,100%)"><p style="color:#f1f1f1;margin:0 0 12px;font:14px Arial">Navion could not stream this video directly. Showing YouTube embed player.</p><iframe src="'+esc(p("https://www.youtube.com/embed/"+encodeURIComponent(v)+"?playsinline=1&rel=0"))+'" style="width:100%;aspect-ratio:16/9;border:0;border-radius:8px;background:#000" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><button type="button" style="margin-top:12px;border:1px solid #555;background:#222;color:#fff;border-radius:6px;padding:8px 14px;cursor:pointer">Close</button></div>';document.body.appendChild(box);box.querySelector("button").addEventListener("click",function(){box.remove();nvPlaybackFailed=false})}` +
  `document.addEventListener("error",function(e){var t=e.target;if(!t)return;if(t.tagName==="VIDEO"||t.tagName==="SOURCE"||(t.tagName==="IFRAME"&&String(t.src||"").indexOf("googlevideo")!==-1))setTimeout(showEmbed,300)},true);setInterval(function(){try{var v=document.querySelector("video.html5-main-video,video");if(v&&v.error&&v.error.code>0&&!v.currentTime)setTimeout(showEmbed,800)}catch(e){}},2500);` +
  `d();setInterval(d,1200);document.addEventListener("submit",r,true);document.addEventListener("click",c,true);document.addEventListener("keydown",y,true);addEventListener("load",function(){d()},true);addEventListener("wheel",z,{capture:true,passive:false});addEventListener("touchmove",z,{capture:true,passive:false});addEventListener("keydown",function(e){if([" ","PageDown","PageUp","ArrowDown","ArrowUp"].indexOf(e.key)!==-1)z(e)},true);` +
  `}();</script>`;

const INJECT = (base, mode, youtubeHelper, youtubeRecovery) =>
  NETWORK_PATCH(base) +
  DARK_MODE_HINT + DARK_MODE_SCRIPT + `<script>!function(){` +
  `if(window.__navionRuntimeLoaded)return;window.__navionRuntimeLoaded=true;window.__navionScope=window.__navionScope||{window:window,self:window.self||window,globalThis:window.globalThis||window};` +
  `try{window.open=function(u,t){if(typeof u==="string"&&/^_(?:self|top|parent)$/i.test(String(t||"")))location.assign(window.__navion&&window.__navion.rewrite?window.__navion.rewrite(u,window.__navion.base):u);return null}}catch(e){}` +
  `var _cw=console.warn,_ce=console.error,_cl=console.log;function _nf(a){try{var s=Array.prototype.join.call(a," ");return s.indexOf("The Chrome/Firefox/Safari extension cannot be detected on localhost")!==-1||s.indexOf("Navigator is not modified on localhost")!==-1||s.indexOf("Use ngrok to detect the extension")!==-1||s.indexOf("ChunkLoadError: Loading chunk")!==-1||s.indexOf("Loading chunk 2005 failed")!==-1||s.indexOf("useTranslation: SUBSCRIPTION_LINK_FOOTER is not available")!==-1||s.indexOf("working version is:")!==-1||s.indexOf("LegacyDataMixin will be applied to all legacy elements")!==-1||s.indexOf("_legacyUndefinedCheck: true")!==-1||s.indexOf("preloaded using link preload but not used")!==-1||s.indexOf("SES Removing unpermitted intrinsics")!==-1||s.indexOf("requestStorageAccessFor: Only supported")!==-1||s.indexOf("violates the following Content Security Policy directive")!==-1||s.indexOf("Refused to display")!==-1;}catch(e){return false}}console.warn=function(){if(_nf(arguments))return;return _cw.apply(console,arguments)};console.error=function(){if(_nf(arguments))return;return _ce.apply(console,arguments)};console.log=function(){if(_nf(arguments))return;return _cl.apply(console,arguments)};` +
  `var c=window.__navion={prefix:"/nv/",base:${JSON.stringify(base)},` +
  `mode:${JSON.stringify(mode || "full")},` +
  `encode:function(u){try{return btoa(encodeURIComponent(u)).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}catch(e){return u}},` +
  `decode:function(e){try{var p=e+"=".repeat((4-e.length%4)%4);return decodeURIComponent(atob(p.replace(/-/g,"+").replace(/_/g,"/")))}catch(e){return e}},` +
  `rewrite:function(u,b){if(!u)return u;var t=String(u).trim();` +
  `if(/^(javascript:|data:|blob:|#|mailto:|tel:|about:|\\/nv\\/)/i.test(t))return u;` +
  `try{var e0=new URL(t,b||location.href);var h0=e0.hostname.toLowerCase();if((e0.protocol==="http:"||e0.protocol==="https:")&&e0.origin!==location.origin&&(${PROXY_MEDIA_HOST_RE.toString()}).test(h0))return"/nv/"+c.encode(e0.href)}catch(e){}` +
  `try{var e=new URL(t,location.href);if(e.origin===location.origin){if(e.pathname.startsWith("/nv/")||e.pathname==="/api/fetch"||e.pathname==="/api/navion-status"||e.pathname==="/api/jikan"||e.pathname==="/favicon.ico"||e.pathname==="/generate_204"||e.pathname==="/nv.sw.js"||e.pathname==="/nv.client.js"||e.pathname==="/nv.register.js"||e.pathname==="/nav/home"||e.pathname==="/nav/error"||e.pathname==="/app"||e.pathname==="/index.html")return u;t=e.pathname+e.search+e.hash;}}catch(e){}` +
  `try{var r=b?new URL(t,b):new URL(t);if(b){try{var bb=new URL(b);if(r.origin===bb.origin)return"/nv/"+c.encode(r.origin+"/")+r.pathname+r.search+r.hash;}catch(e){}}return"/nv/"+c.encode(r.href)}catch(e){return u}}};` +
  `try{if(window.top!==window&&document.requestStorageAccessFor)Object.defineProperty(document,"requestStorageAccessFor",{configurable:true,value:function(){return Promise.resolve()}})}catch(e){}` +
  `try{if(window.top!==window.self&&window.__navion)window.__navion.mode="lite-nav"}catch(e){}` +
  `var _po=location.origin;c._rl=window.location;` +
  `function _tryTok(raw){try{var d=c.decode(raw);if(/^https?:\\/\\//i.test(d))return d}catch(e){}return""}` +
  `function _token(p){p=String(p||"");if(p.indexOf("/nv/")!==0)return"";var r=p.slice(4),s=r.indexOf("/"),t=s<0?r:r.slice(0,s);if(s<0){var m=["dist/","_next/","country.json","duckchat/","static/"];for(var i=0;i<m.length;i++){var x=r.indexOf(m[i]);if(x>0){t=r.slice(0,x);break}}}if(_tryTok(r)&&c.encode(_tryTok(r))===r)return r;if(_tryTok(t)&&c.encode(_tryTok(t))===t)return t;for(var j=r.length-1;j>=12;j--){var cand=r.slice(0,j),dec=_tryTok(cand);if(dec&&dec.charAt(dec.length-1)==="/"&&c.encode(dec)===cand)return cand}return t}` +
  `function _base(){try{var t=_token(location.pathname);if(t){var d=c.decode(t);if(/^https?:\\/\\//i.test(d))return d;}}catch(e){}return c.base;}` +
  `function _hcdnRoot(){try{var res=performance.getEntriesByType("resource");for(var i=res.length-1;i>=0;i--){var n=String(res[i].name||"");if(n.indexOf("/nv/")!==0||n.indexOf("-h.xyz")<0||n.indexOf("manifest.mpd")<0)continue;var tok=n.slice(4).split("/")[0],dec=_tryTok(tok);if(!dec)continue;var extra=n.slice(4+tok.length),full=dec.replace(/\\/?$/,"")+extra,fu=new URL(full),bits=fu.pathname.split("/").filter(Boolean);if(bits.length)return fu.origin+"/"+bits[0]}}catch(e){}return""}` +
  `function _rwUrl(u){try{if(typeof u!=="string"||!u)return u;try{if(u.charAt(0)==="/"&&u.indexOf("/nv/")!==0&&u.indexOf("/nav/")!==0&&u.indexOf("/app")!==0){var hroot=_hcdnRoot();if(hroot)return c.rewrite(hroot+u,_base())}}catch(e0){}try{var tg=new URL(u,_base());if(/pornhub\\.com$/i.test(tg.hostname.replace(/^www\\./i,""))||/\\.pornhub\\.com$/i.test(tg.hostname)){var us=tg.searchParams.get("utm_source")||"";if((tg.pathname==="/"||tg.pathname==="")&&/localhost|127\\.0\\.0\\.1/i.test(us)){if(/view_video/i.test(location.pathname))return location.href;return c.rewrite(tg.origin+"/view_video.php"+location.search,_base())}if(tg.searchParams.has("utm_source")&&/localhost|127\\.0\\.0\\.1/i.test(us))tg.searchParams.delete("utm_source"),u=tg.href}}catch(e){}return c.rewrite(u,_base())}catch(e){return u}}` +
  `try{var _ps=history.pushState.bind(history),_rs=history.replaceState.bind(history);history.pushState=function(s,t,u){return _ps(s,t,u?_rwUrl(u):u)};history.replaceState=function(s,t,u){return _rs(s,t,u?_rwUrl(u):u)}}catch(e){}` +
  `try{var _la=location.assign.bind(location),_lr=location.replace.bind(location);location.assign=function(u){return _la(_rwUrl(u))};location.replace=function(u){return _lr(_rwUrl(u))};var _hd=Object.getOwnPropertyDescriptor(Location.prototype,"href");if(_hd&&_hd.set){Object.defineProperty(location,"href",{configurable:true,enumerable:_hd.enumerable,get:_hd.get,set:function(v){return _hd.set.call(this,_rwUrl(v))}})}if(window.top!==window&&window.top.location){window.top.location.assign=function(u){return location.assign(_rwUrl(u))};window.top.location.replace=function(u){return location.replace(_rwUrl(u))};if(_hd&&_hd.set){Object.defineProperty(window.top.location,"href",{configurable:true,enumerable:_hd.enumerable,get:_hd.get.bind(window.top.location),set:function(v){return location.assign(_rwUrl(v))}})}}}catch(e){}` +
  `function _rw(i){try{if(i==null)return i;if(typeof i==="string"){if(/^\\/nv\\//i.test(i))return i;return c.rewrite(i,_base())}if(i&&typeof i.url==="string"){if(/^\\/nv\\//i.test(i.url))return i;var v=c.rewrite(i.url,_base());return v!==i.url?new Request(v,i):i}return i}catch(e){return i}}` +
  `document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("a[href]");if(!el)return;var h=el.getAttribute("href");if(!h||h.startsWith("#")||h.startsWith("javascript:"))return;var p=c.rewrite(h,_base());if(p&&p!==h)el.setAttribute("href",p);},true);` +
  `document.addEventListener("submit",function(e){var f=e.target;if(!f||!f.action)return;var p=c.rewrite(f.action,_base());if(p&&p!==f.action)f.action=p;},true);` +
  `}();</script>` +
  `<script src="/nv.register.js?v=${RUNTIME_VERSION}"></script>` +
  `<script src="/nv.client.js?v=${RUNTIME_VERSION}"></script>` +
  (youtubeRecovery ? YOUTUBE_RECOVERY(base) : youtubeHelper ? YOUTUBE_HELPER(base) : "");

export function rewriteHtml(html, base, options = {}) {
  const injectRuntime = options.injectRuntime !== false;
  const runtimeMode = options.runtimeMode || "full";
  const rewriteMode = options.rewriteMode || "full";
  const injectYouTubeHelper = options.injectYouTubeHelper === true || options.runtimeMode === "youtube";
  const injectYouTubeRecovery = options.injectYouTubeRecovery === true;
  const rewriteInlineScripts = options.rewriteInlineScripts !== false;
  const out = [];
  let i = 0;
  let inScript = false;
  let inStyle = false;
  let styleBuf = "";
  let scriptBuf = "";
  let injected = false;

  while (i < html.length) {
    if (html.charCodeAt(i) !== 60) {
      const next = html.indexOf("<", i);
      if (next === -1) {
        if (inStyle) styleBuf += html.slice(i);
        else if (inScript) scriptBuf += html.slice(i);
        else out.push(html.slice(i));
        break;
      }
      if (inStyle) styleBuf += html.slice(i, next);
      else if (inScript) scriptBuf += html.slice(i, next);
      else out.push(html.slice(i, next));
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
      if (isClose && tag === "script") {
        inScript = false;
        out.push(rewriteInlineScripts ? rewriteJs(scriptBuf, base) : scriptBuf);
        scriptBuf = "";
        out.push("</script>");
      } else {
        scriptBuf += html.slice(i, tagEnd + 1);
      }
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
      if (injectRuntime && !injected && tag === "head") { out.push(INJECT(base, runtimeMode, injectYouTubeHelper, injectYouTubeRecovery)); injected = true; }
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

    if (injectRuntime && tag === "head" && !injected) { out.push(INJECT(base, runtimeMode, injectYouTubeHelper, injectYouTubeRecovery)); injected = true; }
    if (tag === "script") inScript = true;
    if (tag === "style") inStyle = true;

    i = tagEnd + 1;
  }

  if (injectRuntime && !injected) out.unshift(INJECT(base, runtimeMode, injectYouTubeHelper, injectYouTubeRecovery));
  return out.join("");
}
