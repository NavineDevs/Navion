import { chromium } from "playwright";
import { encode } from "../src/rewriters/url.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.NAVION_TEST_BASE || "http://localhost:8090";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

async function fetchProxiedHomeVideoPath() {
  const api = `${BASE}/api/fetch?url=${encodeURIComponent(encode("https://www.pornhub.com/"))}`;
  const res = await fetch(api, { headers: { accept: "text/html" } });
  const text = await res.text();
  const match = text.match(/\/nv\/[^"']+view_video\.php\?viewkey=[^"']+/i);
  return match ? match[0] : null;
}

const sites = [
  { name: "youtube", open: `/nv/${encode("https://www.youtube.com/")}watch?v=dQw4w9WgXcQ`, wait: 15000, ready: "video, #movie_player, ytd-player, iframe#nvyt-embed-fallback, .nvyt-shell" },
  { name: "pornhub", setup: async (page) => {
    const videoPath = await fetchProxiedHomeVideoPath();
    if (!videoPath) throw new Error("no proxied video link");
    await page.goto(`${BASE}/app?open=${encodeURIComponent(videoPath)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("#nvUrl", { timeout: 30000 });
    await page.waitForTimeout(12000);
  }, ready: "#player, .mgp_videoWrapper, video, #videoShow, #playerContainer, .mgp_player" },
  { name: "hanime", open: `/nv/${encode("https://hanime.tv/")}`, wait: 12000 },
  { name: "uncensoredhentai", open: `/nv/${encode("https://uncensoredhentai.xxx/watch/love-wa-gal-kara-hajimaru-unmei-episode-2/")}`, wait: 12000, ready: "video, iframe, .player, #player, .jwplayer" },
  { name: "navianime", open: `/nv/${encode("https://navianime.vercel.app/")}`, wait: 12000 },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const results = [];

for (const site of sites) {
  const page = await context.newPage();
  try {
    if (site.setup) {
      await site.setup(page);
    } else {
      await page.goto(`${BASE}/app?open=${encodeURIComponent(site.open)}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector("#nvUrl", { timeout: 30000 });
      await page.waitForTimeout(site.wait);
    }
    const frame = page.frameLocator("#nvFrame");
    if (site.ready) {
      await frame.locator(site.ready).first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
    const bar = await page.inputValue("#nvUrl");
    const body = await frame.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    const title = await frame.locator("title").innerText({ timeout: 3000 }).catch(() => "");
    const hasPlayer = await frame.locator("video, #movie_player, ytd-player, iframe#nvyt-embed-fallback, .nvyt-shell, #player, .mgp_videoWrapper").count();
    const chromeErr = page.frames().some((f) => f.url().startsWith("chrome-error"));
    const shotPath = path.join(outDir, `${site.name}.png`);
    await page.locator("#nvFrame").screenshot({ path: shotPath });
    const ok = !chromeErr && bar.length > 0 && (body.length > 50 || hasPlayer > 0 || title.length > 10);
    results.push({ name: site.name, ok, bar, bodyLen: body.length, shot: shotPath });
    console.log(`${ok ? "PASS" : "FAIL"} ${site.name} bar=${bar} body=${body.length} -> ${shotPath}`);
  } catch (e) {
    results.push({ name: site.name, ok: false, error: e.message });
    console.log(`FAIL ${site.name} ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
if (failed.length) process.exit(1);
