import assert from "node:assert/strict";
import test from "node:test";
import {
  __upstreamProxyTestInternals,
  createUpstreamProxyConfig,
  shouldUseUpstreamProxy,
  isKnownBlockedHost,
} from "../src/internal/upstream-proxy.js";

const { hostMatchesPattern, parseHostRules, parseProxyUrl } = __upstreamProxyTestInternals;

test("upstream proxy host rules match blocked adult domains", () => {
  const config = createUpstreamProxyConfig({
    NAVION_UPSTREAM_PROXY: "socks5://127.0.0.1:1080",
  });
  assert.equal(shouldUseUpstreamProxy("www.pornhub.com", config), true);
  assert.equal(shouldUseUpstreamProxy("hanime.tv", config), true);
  assert.equal(shouldUseUpstreamProxy("cdn.hanime.tv", config), true);
  assert.equal(shouldUseUpstreamProxy("www.youtube.com", config), false);
  assert.equal(shouldUseUpstreamProxy("uncensoredhentai.xxx", config), false);
});

test("upstream proxy all mode routes every host", () => {
  const config = createUpstreamProxyConfig({
    NAVION_UPSTREAM_PROXY: "http://127.0.0.1:7890",
    NAVION_UPSTREAM_PROXY_ALL: "1",
  });
  assert.equal(shouldUseUpstreamProxy("example.com", config), true);
});

test("custom host rules override defaults", () => {
  const config = createUpstreamProxyConfig({
    NAVION_UPSTREAM_PROXY: "socks5://127.0.0.1:1080",
    NAVION_UPSTREAM_PROXY_HOSTS: "*.example.org,news.site",
  });
  assert.equal(shouldUseUpstreamProxy("api.example.org", config), true);
  assert.equal(shouldUseUpstreamProxy("news.site", config), true);
  assert.equal(shouldUseUpstreamProxy("pornhub.com", config), false);
});

test("proxy url parser accepts socks5 and http forms", () => {
  assert.deepEqual(parseProxyUrl("socks5://127.0.0.1:1080"), {
    scheme: "socks5",
    hostname: "127.0.0.1",
    port: 1080,
    username: "",
    password: "",
    raw: "socks5://127.0.0.1:1080",
  });
  const auth = parseProxyUrl("http://user:pass@127.0.0.1:8888");
  assert.equal(auth.username, "user");
  assert.equal(auth.password, "pass");
  assert.equal(auth.port, 8888);
});

test("host pattern matcher supports wildcard suffixes", () => {
  assert.equal(hostMatchesPattern("cdn.phncdn.com", "*.phncdn.com"), true);
  assert.equal(hostMatchesPattern("phncdn.com", "*.phncdn.com"), true);
  assert.equal(hostMatchesPattern("example.com", "*.phncdn.com"), false);
});

test("known blocked hosts include pornhub and hanime defaults", () => {
  const config = createUpstreamProxyConfig({});
  assert.equal(isKnownBlockedHost("www.pornhub.com", config), true);
  assert.equal(isKnownBlockedHost("hanime.tv", config), true);
  assert.equal(isKnownBlockedHost("www.youtube.com", config), false);
});

test("parseHostRules supports star routing", () => {
  assert.deepEqual(parseHostRules("*"), ["*"]);
  assert.ok(parseHostRules("").length > 0);
});
