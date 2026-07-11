import { chromium } from "playwright";
import { encode } from "../src/rewriters/url.js";

const BASE = process.env.NAVION_TEST_BASE || "http://localhost:8090";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const results = [];

async function withPage(fn) {
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

async function check(name, fn) {
  try {
    const out = await withPage(fn);
    results.push({ name, ok: true, ...out });
    console.log(`PASS ${name}`, JSON.stringify(out));
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL ${name}`, e.message);
  }
}

await check("shell-url-bar", async (page) => {
  const open = `/nv/${encode("https://www.pornhub.com/")}`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(open)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  const bar = await page.inputValue("#nvUrl");
  if (!/pornhub/i.test(bar)) throw new Error(`url bar shows ${bar}`);
  return { bar };
});

await check("pornhub-video", async (page) => {
  const home = `/nv/${encode("https://www.pornhub.com/")}`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(home)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(10000);
  const frame = page.frameLocator("#nvFrame");
  const href = await frame.locator('a[href*="view_video"]').first().getAttribute("href", { timeout: 20000 });
  if (!href) throw new Error("no video link");
  const open = href.startsWith("/") ? href : `/nv/${encode(href)}`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(open)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(12000);
  const bar = await page.inputValue("#nvUrl");
  const hasPlayer = await frame.locator("#player, .mgp_videoWrapper, video, #videoShow, #playerContainer, .mgp_player").count();
  const body = await frame.locator("body").innerText({ timeout: 8000 }).catch(() => "");
  if (!/pornhub/i.test(bar)) throw new Error(`bar=${bar}`);
  if (/missing url|no url was provided/i.test(body)) throw new Error(`proxy error: ${body}`);
  if (hasPlayer === 0) throw new Error("no player element");
  return { bar, hasPlayer };
});

await check("youtube-watch", async (page) => {
  const open = `/nv/${encode("https://www.youtube.com/")}watch?v=dQw4w9WgXcQ`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(open)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(15000);
  const frame = page.frameLocator("#nvFrame");
  const hasVideo = await frame.locator("video").count();
  const hasEmbed = await frame.locator("iframe#nvyt-embed-fallback, .nvyt-shell iframe, #movie_player, ytd-player").count();
  const body = await frame.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const title = await page.inputValue("#nvUrl");
  if (!/youtube/i.test(title)) throw new Error(`bar=${title}`);
  if (hasVideo === 0 && hasEmbed === 0 && !/youtube|search|watch/i.test(body)) throw new Error("no video, player, or youtube content");
  return { hasVideo, hasEmbed, title };
});

await check("navianime-load", async (page) => {
  const open = `/nv/${encode("https://navianime.vercel.app/")}`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(open)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(10000);
  const frame = page.frameLocator("#nvFrame");
  const text = await frame.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const bar = await page.inputValue("#nvUrl");
  if (!/navianime|vercel/i.test(bar)) throw new Error(`bar=${bar}`);
  if (text.length < 50) throw new Error(`body too small: ${text.slice(0, 80)}`);
  if (/application error|client-side exception|500/i.test(text)) throw new Error(`error page: ${text.slice(0, 120)}`);
  return { bar, textLen: text.length, preview: text.slice(0, 80) };
});

await check("uncensoredhentai", async (page) => {
  const open = `/nv/${encode("https://uncensoredhentai.xxx/watch/love-wa-gal-kara-hajimaru-unmei-episode-2/")}`;
  await page.goto(`${BASE}/app?open=${encodeURIComponent(open)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(10000);
  const frame = page.frameLocator("#nvFrame");
  const hasPlayer = await frame.locator("video, iframe, .player, #player, .jwplayer, .frame iframe").count();
  const bar = await page.inputValue("#nvUrl");
  if (!/uncensoredhentai/i.test(bar)) throw new Error(`bar=${bar}`);
  if (hasPlayer === 0) throw new Error("no player on episode page");
  return { bar, hasPlayer };
});

await browser.close();
const failed = results.filter((r) => !r.ok);
process.exit(failed.length ? 1 : 0);
