import assert from "node:assert/strict";
import test from "node:test";
import { rewriteHtml } from "../src/rewriters/html.js";
import { rewriteJs, rewriteMediaUrlLiterals } from "../src/rewriters/js.js";
import { __navionTestInternals } from "../src/proxy.js";

const {
  buildCorsPreflightHeaders,
  buildOutHeaders,
  isStreamableMediaTarget,
  shouldUseAssetFallback,
  rewriteLocationHeader,
  rewriteMediaManifest,
  isUpstreamBlockedFetchError,
  upstreamBlockedMessage,
} = __navionTestInternals;

test("proxied response headers strip frame and CSP policy", () => {
  const headers = buildOutHeaders({
    "content-security-policy": "frame-ancestors 'none'",
    "content-security-policy-report-only": "default-src 'self'",
    "x-frame-options": "sameorigin",
    "cross-origin-opener-policy": "same-origin",
    "content-type": "text/html",
  }, { headers: { origin: "https://app.example" } });

  assert.equal(headers["content-security-policy"], undefined);
  assert.equal(headers["content-security-policy-report-only"], undefined);
  assert.equal(headers["x-frame-options"], undefined);
  assert.equal(headers["cross-origin-opener-policy"], undefined);
  assert.equal(headers["content-type"], "text/html");
  assert.equal(headers["access-control-allow-origin"], "https://app.example");
});

test("location headers rewrite absolute and relative redirects", () => {
  assert.equal(
    rewriteLocationHeader("/next?a=1", "https://example.com/start"),
    "/nv/aHR0cHMlM0ElMkYlMkZleGFtcGxlLmNvbSUyRm5leHQlM0ZhJTNEMQ"
  );
  assert.equal(
    rewriteLocationHeader("https://cdn.example/video.m3u8", "https://example.com/start"),
    "/nv/aHR0cHMlM0ElMkYlMkZjZG4uZXhhbXBsZSUyRnZpZGVvLm0zdTg"
  );
});

test("OPTIONS preflight allows range and media request headers", () => {
  const headers = buildCorsPreflightHeaders({ headers: { origin: "https://app.example" } });
  assert.equal(headers["access-control-allow-origin"], "https://app.example");
  assert.match(headers["access-control-allow-methods"], /OPTIONS/);
  assert.match(headers["access-control-allow-headers"], /range/);
  assert.match(headers["access-control-allow-headers"], /if-range/);
  assert.match(headers["access-control-allow-headers"], /accept-language/);
});

test("m3u8 manifests rewrite segment lines and URI attributes", () => {
  const manifest = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"",
    "#EXT-X-MAP:URI='../init.mp4'",
    "#EXT-X-STREAM-INF:BANDWIDTH=1280000,URI=\"https://cdn.example/variant.m3u8\"",
    "../seg-1.ts",
    "https://media.example/seg-2.ts",
  ].join("\n");
  const out = rewriteMediaManifest(manifest, "https://video.example/path/master.m3u8");

  assert.match(out, /URI="\/nv\//);
  assert.match(out, /URI='\/nv\//);
  assert.match(out, /\/nv\/[A-Za-z0-9_-]+\/seg-1\.ts/);
  assert.match(out, /\/nv\/[A-Za-z0-9_-]+c2VnLTIudHM/);
});

test("streamable media includes ranged video and audio targets", () => {
  assert.equal(isStreamableMediaTarget("https://cdn.example/movie.mp4", ""), true);
  assert.equal(isStreamableMediaTarget("https://cdn.example/seg.ts", ""), true);
  assert.equal(isStreamableMediaTarget("https://cdn.example/file", "video/mp4"), true);
  assert.equal(isStreamableMediaTarget("https://cdn.example/file", "audio/aac"), true);
});

test("js rewriter blocks site service workers and rewrites URL-bearing globals only", () => {
  const input = [
    "navigator.serviceWorker.register('/sw.js');",
    "self.location.href = '/next';",
    "globalThis.location.assign('/assign');",
    "window.location.replace('/replace');",
    "const untouched = self.foo + window.bar + globalThis.baz;",
  ].join("\n");
  const out = rewriteJs(input, "https://example.com/base/");

  assert.match(out, /Promise\.reject\(new DOMException\("Blocked by Navion proxy scope","SecurityError"\)\)/);
  assert.match(out, /self\.location\.href = '\/nv\//);
  assert.match(out, /globalThis\.location\.assign\('\/nv\//);
  assert.match(out, /window\.location\.replace\('\/nv\//);
  assert.match(out, /self\.foo \+ window\.bar \+ globalThis\.baz/);
});

test("media url literals rewrite adult and youtube cdn strings", () => {
  const input = 'var defs=[{"videoUrl":"https://pix-fl.phncdn.com/video.mp4"},{"videoUrl":"https:\\/\\/pix-fl.phncdn.com\\/video2.mp4"}];';
  const out = rewriteMediaUrlLiterals(input, "https://www.pornhub.com/view_video.php?viewkey=test");
  assert.match(out, /\/nv\//);
  assert.doesNotMatch(out, /https:\/\/pix-fl\.phncdn\.com\/video\.mp4/);
});

test("inline html scripts rewrite embedded media urls", () => {
  const out = rewriteHtml(
    '<html><head></head><body><script>var mediaDefinitions=[{"videoUrl":"https://pix-fl.phncdn.com/video.mp4"}];</script></body></html>',
    "https://www.pornhub.com/view_video.php?viewkey=test",
    { injectRuntime: false, rewriteMode: "full" }
  );
  assert.match(out, /\/nv\//);
  assert.doesNotMatch(out, /https:\/\/pix-fl\.phncdn\.com\/video\.mp4/);
});

test("youtube html receives normal runtime and youtube helper", () => {
  const out = rewriteHtml("<html><head></head><body></body></html>", "https://www.youtube.com/", {
    injectRuntime: true,
    runtimeMode: "full",
    rewriteMode: "full",
    injectYouTubeHelper: true,
  });

  assert.match(out, /window\.__navionRuntimeLoaded/);
  assert.match(out, /\/nv\.client\.js\?v=1\.0\.19/);
  assert.match(out, /HTMLScriptElement&&HTMLScriptElement\.prototype/);
  assert.match(out, /HTMLLinkElement&&HTMLLinkElement\.prototype/);
  assert.match(out, /yt-searchbox/);
});

test("asset fallback rejects bad css and script mime types", () => {
  assert.equal(shouldUseAssetFallback(
    { headers: { "sec-fetch-dest": "style", accept: "text/css" } },
    "https://www.youtube.com/s/player/www-player.css",
    "image/jpeg"
  ), true);
  assert.equal(shouldUseAssetFallback(
    { headers: { "sec-fetch-dest": "script", accept: "application/javascript" } },
    "https://www.youtube.com/s/desktop/base.js",
    "text/html"
  ), true);
  assert.equal(shouldUseAssetFallback(
    { headers: { "sec-fetch-dest": "style", accept: "text/css" } },
    "https://www.youtube.com/s/player/www-player.css",
    "text/css; charset=utf-8"
  ), false);
});

test("blocked fetch errors surface built-in direct-connection guidance", () => {
  const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isUpstreamBlockedFetchError(err, "www.pornhub.com"), true);
  assert.equal(isUpstreamBlockedFetchError(err, "www.youtube.com"), false);
  assert.match(upstreamBlockedMessage("hanime.tv"), /hanime\.tv/);
  assert.match(upstreamBlockedMessage("hanime.tv"), /built-in encrypted DNS/);
});
