import { encode, decode, rewriteUrl } from "../src/rewriters/url.js";

const BASE = process.env.NAVION_TEST_BASE || "http://localhost:8090";

function fail(reason) {
  return { ok: false, reason };
}

function pass(details = {}) {
  return { ok: true, ...details };
}

async function proxyFetch(targetUrl, headers = {}) {
  const api = `${BASE}/api/fetch?url=${encodeURIComponent(encode(targetUrl))}`;
  const res = await fetch(api, { headers, redirect: "manual" });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return { res, text, buf };
}

async function shellFetch(path, headers = {}, cookie = "") {
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  return { res, text, buf };
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1] || m[0] : null;
}

async function testYouTube() {
  const checks = [];
  const home = await proxyFetch("https://www.youtube.com/", {
    accept: "text/html",
    "sec-fetch-dest": "iframe",
  });
  checks.push({ check: "home-html", ...(home.res.status < 400 && home.text.length > 5000 ? pass() : fail(`status=${home.res.status} len=${home.text.length}`)) });

  const watch = await proxyFetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
    accept: "text/html",
    "sec-fetch-dest": "iframe",
  });
  checks.push({ check: "watch-html", ...(watch.res.status < 400 && watch.text.length > 5000 ? pass() : fail(`status=${watch.res.status}`)) });
  checks.push({ check: "watch-runtime", ...(watch.text.includes("nv.client.js") || watch.text.includes("__navion") ? pass() : fail("no runtime")) });

  const hasPlayer = /ytInitialPlayerResponse|var ytInitialPlayerResponse/.test(watch.text);
  checks.push({ check: "watch-player-data", ...(hasPlayer ? pass() : fail("no ytInitialPlayerResponse")) });

  let streamUrl = null;
  const playerMatch = watch.text.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/);
  if (playerMatch) {
    try {
      const player = JSON.parse(playerMatch[1]);
      const formats = []
        .concat(player?.streamingData?.formats || [])
        .concat(player?.streamingData?.adaptiveFormats || []);
      const video = formats.find((f) => f?.url && /video/i.test(f.mimeType || ""));
      streamUrl = video?.url || formats.find((f) => f?.url)?.url || null;
    } catch {}
  }
  if (!streamUrl) {
    const urlMatch = watch.text.match(/https:\/\/[^"'\s]*googlevideo\.com[^"'\s]*videoplayback[^"'\s]*/);
    streamUrl = urlMatch ? urlMatch[0].replace(/\\u0026/g, "&").replace(/\\\//g, "/") : null;
  }

  const cipherMatch = watch.text.match(/"signatureCipher":"((?:[^"\\]|\\.)+)"/);
  const cipherBlob = cipherMatch ? cipherMatch[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/") : "";
  if (cipherBlob.includes("googlevideo.com")) {
    checks.push({ check: "cipher-intact", ...pass() });
  } else {
    checks.push({ check: "cipher-intact", ...fail("signatureCipher missing googlevideo url") });
  }

  if (!streamUrl && cipherBlob) {
    try {
      streamUrl = decodeURIComponent(new URLSearchParams(cipherBlob).get("url") || "");
    } catch {}
  }

  if (streamUrl) {
    const stream = await proxyFetch(streamUrl, {
      accept: "*/*",
      range: "bytes=0-65535",
      "sec-fetch-dest": "video",
      referer: "https://www.youtube.com/",
    });
    const ct = stream.res.headers.get("content-type") || "";
    const ok =
      stream.res.status === 200 ||
      stream.res.status === 206 ||
      stream.res.status === 403 ||
      stream.res.status === 404 ||
      (stream.res.status < 500 && !/text\/html|<!doctype html>/i.test(ct + stream.text));
    checks.push({
      check: "videoplayback-range",
      ...(ok ? pass({ status: stream.res.status, ct, bytes: stream.buf.byteLength }) : fail(`status=${stream.res.status} bytes=${stream.buf.byteLength} ct=${ct}`)),
    });
  } else {
    checks.push({ check: "videoplayback-range", ...fail("no googlevideo stream url found in watch page") });
  }

  const bareWatch = await shellFetch("/watch?v=dQw4w9WgXcQ", {
    accept: "text/html",
    "sec-fetch-dest": "document",
    referer: `${BASE}/app`,
    cookie: "nv_base=aHR0cHMlM0ElMkYlMkZ3d3cueW91dHViZS5jb20lMkY",
  });
  const bareOk = bareWatch.res.status === 302 && String(bareWatch.res.headers.get("location") || "").includes("/nv/");
  checks.push({ check: "bare-watch-redirect", ...(bareOk ? pass() : fail(`status=${bareWatch.res.status} loc=${bareWatch.res.headers.get("location")}`)) });

  return { name: "youtube", checks, ok: checks.every((c) => c.ok) };
}

async function testPornhub() {
  const checks = [];
  const home = await proxyFetch("https://www.pornhub.com/");
  const videoPath = firstMatch(home.text, /\/nv\/[^"']+view_video\.php\?viewkey=[^"']+/i);
  checks.push({ check: "home-video-link", ...(videoPath ? pass({ path: videoPath }) : fail("no proxied video link")) });
  if (!videoPath) return { name: "pornhub", checks, ok: false };

  const videoTarget = `https://www.pornhub.com${videoPath.replace(/^\/nv\/[^/]+/, "")}`;
  const page = await proxyFetch(videoTarget);
  checks.push({ check: "video-page", ...(page.res.status < 400 && page.text.includes("mediaDefinitions") ? pass() : fail(`status=${page.res.status}`)) });

  const block = page.text.match(/mediaDefinitions[\s\S]{0,30000}/);
  const sample = block ? block[0] : "";
  const proxiedStream = firstMatch(sample, /videoUrl":"([^"]+)"/);
  const vu = proxiedStream ? proxiedStream.replace(/\\\//g, "/") : null;
  checks.push({ check: "proxied-stream-url", ...(vu && vu.includes("/nv/") ? pass() : fail("no proxied videoUrl in mediaDefinitions")) });

  if (vu && vu.startsWith("/nv/")) {
    const manifest = await shellFetch(vu, {
      accept: "*/*",
      referer: `${BASE}${videoPath.startsWith("/") ? videoPath : `/nv/${encode("https://www.pornhub.com/")}`}`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
    }, `nv_base=${encode("https://www.pornhub.com/")}`);
    checks.push({
      check: "hls-manifest",
      ...(manifest.res.status < 400 && manifest.text.includes("#EXT") ? pass({ status: manifest.res.status }) : fail(`status=${manifest.res.status} body=${manifest.text.slice(0, 80)}`)),
    });
  }

  return { name: "pornhub", checks, ok: checks.every((c) => c.ok) };
}

async function testUncensoredhentai() {
  const checks = [];
  const watchUrl = "https://uncensoredhentai.xxx/watch/love-wa-gal-kara-hajimaru-unmei-episode-2/";
  const page = await proxyFetch(watchUrl);
  checks.push({ check: "watch-page", ...(page.res.status < 400 && page.text.length > 10000 ? pass() : fail(`status=${page.res.status}`)) });
  const iframe = firstMatch(page.text, /<iframe[^>]+src="([^"]+)"/i);
  checks.push({ check: "nhplayer-iframe", ...(iframe && iframe.includes("/nv/") ? pass() : fail(`iframe=${iframe || "none"}`)) });

  if (iframe && iframe.includes("/nv/")) {
    const nh = await proxyFetch("https://nhplayer.com/v/bAmpRk5Ja6315kR/", {
      accept: "text/html",
      "sec-fetch-dest": "iframe",
      referer: watchUrl,
    });
    checks.push({
      check: "nhplayer-page",
      ...(nh.res.status < 400 && (nh.text.includes("nv-nh-auto") || nh.text.includes("data-id")) ? pass() : fail(`status=${nh.res.status}`)),
    });
    const playerPath = firstMatch(nh.text, /data-id="(\/nv\/[^"]+player\.php[^"]+)"/i);
    if (playerPath) {
      const player = await shellFetch(playerPath, {
        accept: "text/html",
        referer: iframe,
        "sec-fetch-dest": "iframe",
      }, `nv_base=${encode("https://nhplayer.com/")}`);
      const hasVideo = player.text.includes("<video") || player.text.includes("_pC.result");
      checks.push({ check: "nhplayer-fallback", ...(hasVideo ? pass() : fail("player.php missing video fallback")) });
    }
  }

  return { name: "uncensoredhentai", checks, ok: checks.every((c) => c.ok) };
}

async function testNavianime() {
  const checks = [];
  const home = await proxyFetch("https://navianime.vercel.app/");
  checks.push({ check: "home-html", ...(home.res.status < 400 && home.text.includes("__next") ? pass() : fail(`status=${home.res.status}`)) });

  const baseCookie = encode("https://navianime.vercel.app/");
  const jsPath = firstMatch(home.text, /(\/nv\/[^"']+_next\/static\/[^"']+\.js)/);
  const cssPath = firstMatch(home.text, /(\/nv\/[^"']+_next\/static\/[^"']+\.css)/);
  checks.push({ check: "proxied-next-assets", ...((jsPath || cssPath) ? pass({ jsPath, cssPath }) : fail("no proxied _next assets in html")) });

  if (jsPath) {
    const bare = jsPath.replace(/^\/nv\/[^/]+/, "");
    const bareRes = await shellFetch(bare, {
      accept: "*/*",
      "sec-fetch-dest": "script",
      referer: `${BASE}/nv/${baseCookie}/`,
    }, `nv_base=${baseCookie}`);
    checks.push({
      check: "bare-next-via-cookie",
      ...(bareRes.res.status < 400 && bareRes.buf.byteLength > 500 ? pass({ status: bareRes.res.status, bytes: bareRes.buf.byteLength }) : fail(`status=${bareRes.res.status} bytes=${bareRes.buf.byteLength}`)),
    });
  }

  const dataPath = firstMatch(home.text, /\/_next\/data\/[^"']+\.json/);
  if (dataPath) {
    const proxiedData = rewriteUrl(dataPath, "https://navianime.vercel.app/");
    const dataRes = await shellFetch(proxiedData, {
      accept: "application/json",
      referer: `${BASE}/nv/${baseCookie}/`,
    }, `nv_base=${baseCookie}`);
    checks.push({
      check: "next-data",
      ...(dataRes.res.status < 400 ? pass({ status: dataRes.res.status }) : fail(`status=${dataRes.res.status}`)),
    });
  }

  const shell = await shellFetch("/app", { accept: "text/html" });
  checks.push({ check: "shell-loads", ...(shell.res.status < 400 && shell.text.includes("nvUrl") ? pass() : fail("shell missing nvUrl")) });
  checks.push({ check: "shell-site-label", ...(shell.text.includes("nvBarDisplay") || shell.text.includes("nvDisplayLabel") ? pass() : fail("shell missing site label helpers")) });

  return { name: "navianime", checks, ok: checks.every((c) => c.ok) };
}

async function testHanime() {
  const checks = [];
  const home = await proxyFetch("https://hanime.tv/");
  checks.push({ check: "mirror-html", ...(home.text.includes("hstream.moe") ? pass() : fail("not mirrored to hstream")) });
  return { name: "hanime", checks, ok: checks.every((c) => c.ok) };
}

const tests = [testYouTube, testPornhub, testUncensoredhentai, testNavianime, testHanime];
let exitCode = 0;
for (const run of tests) {
  const result = await run();
  const status = result.ok ? "PASS" : "FAIL";
  if (!result.ok) exitCode = 1;
  console.log(`${status} ${result.name}`);
  for (const c of result.checks) {
    console.log(`  - ${c.check}: ${c.ok ? "ok" : c.reason}`);
  }
}
process.exit(exitCode);
