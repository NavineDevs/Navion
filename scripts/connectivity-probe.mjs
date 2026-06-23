import https from "node:https";
import http from "node:http";

const targets = [
  { name: "pornhub", url: "https://www.pornhub.com/" },
  { name: "hanime", url: "https://hanime.tv/" },
  { name: "uncensoredhentai", url: "https://uncensoredhentai.xxx/" },
  { name: "youtube", url: "https://www.youtube.com/" },
];

function probe(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const started = Date.now();
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "HEAD",
      headers: { "user-agent": "Mozilla/5.0" },
      timeout: 10000,
      agent: false,
    }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode, ms: Date.now() - started, error: "" });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, ms: Date.now() - started, error: "timeout" });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, ms: Date.now() - started, error: err.code || err.message });
    });
    req.end();
  });
}

const results = [];
for (const target of targets) {
  results.push({ ...target, ...(await probe(target.url)) });
}
console.log(JSON.stringify(results, null, 2));
