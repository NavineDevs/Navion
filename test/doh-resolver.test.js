import assert from "node:assert/strict";
import test from "node:test";
import { __dohTestInternals } from "../src/internal/doh-resolver.js";

const { extractAddresses, createDohConfig } = __dohTestInternals;

test("createDohConfig enables DoH by default", () => {
  const config = createDohConfig({});
  assert.equal(config.enabled, true);
  assert.ok(config.endpoints.length > 0);
});

test("createDohConfig disables DoH when NAVION_DOH is 0", () => {
  const config = createDohConfig({ NAVION_DOH: "0" });
  assert.equal(config.enabled, false);
});

test("createDohConfig accepts custom endpoints", () => {
  const config = createDohConfig({ NAVION_DOH_ENDPOINTS: "https://a.example/dns, https://b.example/dns" });
  assert.deepEqual(config.endpoints, ["https://a.example/dns", "https://b.example/dns"]);
});

test("extractAddresses returns IPv4 A records", () => {
  const answer = { Answer: [{ type: 1, data: "1.2.3.4", TTL: 120 }, { type: 5, data: "cname.example" }] };
  const { addresses, ttl } = extractAddresses(answer, 4);
  assert.deepEqual(addresses, ["1.2.3.4"]);
  assert.equal(ttl, 120);
});

test("extractAddresses returns IPv6 AAAA records", () => {
  const answer = { Answer: [{ type: 28, data: "2606:4700:4700::1111", TTL: 300 }] };
  const { addresses } = extractAddresses(answer, 6);
  assert.deepEqual(addresses, ["2606:4700:4700::1111"]);
});

test("extractAddresses ignores malformed data", () => {
  const answer = { Answer: [{ type: 1, data: "not-an-ip" }] };
  const { addresses } = extractAddresses(answer, 4);
  assert.deepEqual(addresses, []);
});
