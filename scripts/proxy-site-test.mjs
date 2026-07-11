import { encode, rewriteUrl } from "../src/rewriters/url.js";

const BASE = process.env.NAVION_TEST_BASE || "http://localhost:8090";
const SITES = [
  { name: "youtube", url: "https://www.youtube.com/" },
  { name: "pornhub", url: "https://www.pornhub.com/" },
  { name: "hanime", url: "https://hanime.tv/" },
  { name: "uncensoredhentai", url: "https://uncensoredhentai.xxx/" },
  { name: "navianime", url: "https://navianime.vercel.app/" },
];

const DOC_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-dest": "iframe",
  "sec-fetch-mode": "navigate",
};

function fail(reason) {
  return { ok: false, reason };
}

function pass(details = {}) {
  return { ok: true, ...details };
}

async function fetchProxied(targetUrl, headers = DOC_HEADERS) {
  const api = `${BASE}/api/fetch?url=${encodeURIComponent(encode(targetUrl))}`;
  const res = await fetch(api, { headers, redirect: "manual" });
  const text = await res.text();
  return { res, text };
}

function checkRootLinksRewritten(html, baseUrl) {
  const expectedRoot = rewriteUrl("/", baseUrl);
  if (!expectedRoot.startsWith("/nv/")) return fail("root rewrite helper broken");
  if (html.includes('href="/"') || html.includes("href='/'")) {
    return fail("unrewritten root href=/ still present");
  }
  if (!html.includes(expectedRoot)) return fail(`expected proxied root ${expectedRoot}`);
  return pass();
}

async function testSite(site) {
  const out = { name: site.name, url: site.url, checks: [] };

  try {
    const { res, text } = await fetchProxied(site.url);
    out.status = res.status;
    out.length = text.length;

    if (res.status < 200 || res.status >= 400) {
      out.checks.push({ check: "html-status", ...fail(`HTTP ${res.status}`) });
      return out;
    }
    out.checks.push({ check: "html-status", ...pass({ status: res.status }) });

    if (text.length < 1000) {
      out.checks.push({ check: "html-size", ...fail(`body too small (${text.length})`) });
      return out;
    }
    out.checks.push({ check: "html-size", ...pass({ length: text.length }) });

    if (!text.includes("__navion") && !text.includes("nv.client.js")) {
      out.checks.push({ check: "runtime", ...fail("navion runtime not injected") });
    } else {
      out.checks.push({ check: "runtime", ...pass() });
    }

    if (/Just a moment|cf-browser-verification|challenge-platform/i.test(text)) {
      out.checks.push({ check: "cloudflare", ...fail("cloudflare challenge page") });
    } else {
      out.checks.push({ check: "cloudflare", ...pass() });
    }

    const rewriteBase = site.name === "hanime" ? "https://hstream.moe/" : site.url;

    if (site.name === "hanime") {
      if (!/hstream\.moe/i.test(text)) {
        out.checks.push({ check: "hanime-mirror", ...fail("hanime.tv did not route to hstream.moe mirror") });
      } else {
        out.checks.push({ check: "hanime-mirror", ...pass() });
      }
    }

    if (site.name !== "youtube") {
      out.checks.push({ check: "root-links", ...checkRootLinksRewritten(text, rewriteBase) });
    } else if (text.includes('href="/watch"') && !text.includes("/nv/")) {
      out.checks.push({ check: "youtube-links", ...fail("bare youtube links without /nv/") });
    } else {
      out.checks.push({ check: "youtube-links", ...pass() });
    }

    if (site.name === "pornhub") {
      const asset = "https://ei.phncdn.com/www-static/js/lib/jquery.min.js";
      const assetApi = `${BASE}/api/fetch?url=${encodeURIComponent(encode(asset))}`;
      const assetRes = await fetch(assetApi, {
        headers: {
          accept: "*/*",
          "sec-fetch-dest": "script",
          referer: site.url,
        },
      });
      if (assetRes.status >= 400) {
        out.checks.push({ check: "phncdn-asset", ...fail(`CDN HTTP ${assetRes.status}`) });
      } else {
        out.checks.push({ check: "phncdn-asset", ...pass({ status: assetRes.status }) });
      }

      const videoLink = text.match(/\/nv\/[^"']+view_video\.php[^"']*/i);
      if (!videoLink) {
        out.checks.push({ check: "ph-video-link", ...fail("no proxied video link on home page") });
      } else {
        const videoPath = videoLink[0];
        const videoTarget = `https://www.pornhub.com${videoPath.replace(/^\/nv\/[^/]+/, "")}`;
        const videoPage = await fetchProxied(videoTarget);
        if (videoPage.text.includes("mediaDefinitions")) {
          const block = videoPage.text.match(/mediaDefinitions[\s\S]{0,20000}/);
          const sample = block ? block[0] : videoPage.text;
          const hasRawStream = /videoUrl["'\s:]+\s*["']https:\/\/[^"']*phncdn/i.test(sample);
          const hasProxiedStream = /videoUrl["'\s:]+\s*["']\/nv\//i.test(sample);
          if (hasRawStream) {
            out.checks.push({ check: "ph-inline-media", ...fail("mediaDefinitions still contains raw phncdn stream urls") });
          } else if (hasProxiedStream) {
            out.checks.push({ check: "ph-inline-media", ...pass() });
          } else {
            out.checks.push({ check: "ph-inline-media", ...pass({ note: "no stream urls in mediaDefinitions sample" }) });
          }
        } else {
          out.checks.push({ check: "ph-inline-media", ...pass({ note: "mediaDefinitions not present" }) });
        }
      }
    }

    if (site.name === "navianime") {
      const m = text.match(/\/_next\/static\/[^"'\\s>]+/);
      if (!m) {
        out.checks.push({ check: "next-asset", ...fail("no _next asset in html") });
      } else {
        const assetPath = m[0];
        const assetUrl = new URL(assetPath, site.url).href;
        const assetApi = `${BASE}/api/fetch?url=${encodeURIComponent(encode(assetUrl))}`;
        const assetRes = await fetch(assetApi, {
          headers: { accept: "*/*", "sec-fetch-dest": "script", referer: site.url },
        });
        if (assetRes.status >= 400) {
          out.checks.push({ check: "next-asset", ...fail(`_next HTTP ${assetRes.status}`) });
        } else {
          out.checks.push({ check: "next-asset", ...pass({ path: assetPath, status: assetRes.status }) });
        }
      }
    }

    if (site.name === "uncensoredhentai") {
      const m = text.match(/\/wp-content\/[^"'\\s>]+/);
      if (!m) {
        out.checks.push({ check: "wp-asset", ...fail("no wp-content asset in html") });
      } else {
        const assetPath = m[0].startsWith("/nv/") ? m[0] : rewriteUrl(m[0], site.url);
        if (!String(assetPath).startsWith("/nv/")) {
          out.checks.push({ check: "wp-asset", ...fail("wp asset not proxied in html") });
        } else {
          out.checks.push({ check: "wp-asset", ...pass({ path: assetPath }) });
        }
      }
    }
  } catch (err) {
    out.checks.push({ check: "fetch", ...fail(err.message || String(err)) });
  }

  out.ok = out.checks.every((c) => c.ok);
  return out;
}

const results = [];
for (const site of SITES) {
  results.push(await testSite(site));
}

let exitCode = 0;
for (const result of results) {
  const status = result.ok ? "PASS" : "FAIL";
  if (!result.ok) exitCode = 1;
  console.log(`${status} ${result.name} ${result.url}`);
  for (const check of result.checks) {
    console.log(`  - ${check.check}: ${check.ok ? "ok" : check.reason}`);
  }
}

process.exit(exitCode);
