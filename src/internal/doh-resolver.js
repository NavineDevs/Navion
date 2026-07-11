import https from "node:https";
import net from "node:net";
import dns from "node:dns";

const DEFAULT_DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
  "https://dns.quad9.net/dns-query",
];

const RESOLVE_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const MIN_CACHE_TTL_MS = 30 * 1000;
const dohAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function createDohConfig(env = process.env) {
  const disabled = String(env.NAVION_DOH || "").trim() === "0";
  const custom = String(env.NAVION_DOH_ENDPOINTS || "").trim();
  const endpoints = custom
    ? custom.split(",").map((item) => item.trim()).filter(Boolean)
    : [...DEFAULT_DOH_ENDPOINTS];
  return {
    enabled: !disabled,
    endpoints,
    timeoutMs: parseInt(env.NAVION_DOH_TIMEOUT || "4000", 10),
  };
}

function cacheGet(hostname) {
  const entry = RESOLVE_CACHE.get(hostname);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    RESOLVE_CACHE.delete(hostname);
    return undefined;
  }
  return entry.addresses;
}

function cacheSet(hostname, addresses, ttlSeconds) {
  const ttlMs = addresses.length
    ? Math.max(MIN_CACHE_TTL_MS, (ttlSeconds || 0) * 1000 || CACHE_TTL_MS)
    : NEGATIVE_TTL_MS;
  RESOLVE_CACHE.set(hostname, {
    addresses,
    expires: Date.now() + ttlMs,
  });
}

function dohRequest(endpoint, hostname, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    try {
      requestUrl = new URL(endpoint);
    } catch {
      reject(new Error("Invalid DoH endpoint"));
      return;
    }
    requestUrl.searchParams.set("name", hostname);
    requestUrl.searchParams.set("type", type);

    const req = https.request(
      {
        hostname: requestUrl.hostname,
        port: requestUrl.port || 443,
        path: requestUrl.pathname + requestUrl.search,
        method: "GET",
        agent: dohAgent,
        timeout: timeoutMs,
        headers: {
          accept: "application/dns-json",
          "user-agent": "Navion-DoH/1.0",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`DoH status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("DoH request timed out"));
    });
    req.end();
  });
}

function extractAddresses(answer, family) {
  if (!answer || !Array.isArray(answer.Answer)) return { addresses: [], ttl: 0 };
  const wantType = family === 6 ? 28 : 1;
  const addresses = [];
  let ttl = 0;
  for (const record of answer.Answer) {
    if (record.type !== wantType) continue;
    const value = String(record.data || "").trim();
    if (family === 6 ? net.isIPv6(value) : net.isIPv4(value)) {
      addresses.push(value);
      if (!ttl || (record.TTL && record.TTL < ttl)) ttl = record.TTL || ttl;
    }
  }
  return { addresses, ttl };
}

async function resolveViaEndpoints(config, hostname, family) {
  const type = family === 6 ? "AAAA" : "A";
  for (const endpoint of config.endpoints) {
    try {
      const answer = await dohRequest(endpoint, hostname, type, config.timeoutMs);
      const { addresses, ttl } = extractAddresses(answer, family);
      if (addresses.length) return { addresses, ttl };
    } catch {}
  }
  return { addresses: [], ttl: 0 };
}

export async function resolveHostname(hostname, config, family = 4) {
  if (!config?.enabled || !hostname || net.isIP(hostname)) return [];
  const cacheKey = `${family}:${hostname}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const { addresses, ttl } = await resolveViaEndpoints(config, hostname, family);
  cacheSet(cacheKey, addresses, ttl);
  return addresses;
}

export function createDohLookup(config) {
  return function dohLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options || {};
    const family = opts.family === 6 ? 6 : 4;

    const fallback = () => dns.lookup(hostname, opts, cb);

    if (!config?.enabled || net.isIP(hostname)) {
      fallback();
      return;
    }

    resolveHostname(hostname, config, family)
      .then((addresses) => {
        if (!addresses.length && family === 4) return resolveHostname(hostname, config, 6).then((v6) => ({ addresses: v6, family: 6 }));
        return { addresses, family };
      })
      .then((result) => {
        const list = result.addresses || [];
        if (!list.length) {
          fallback();
          return;
        }
        if (opts.all) {
          cb(null, list.map((address) => ({ address, family: result.family })));
        } else {
          cb(null, list[0], result.family);
        }
      })
      .catch(() => fallback());
  };
}

export function resetDohCache() {
  RESOLVE_CACHE.clear();
}

export { createDohConfig, DEFAULT_DOH_ENDPOINTS };

export const __dohTestInternals = {
  extractAddresses,
  createDohConfig,
};
