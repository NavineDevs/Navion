import { createUpstreamProxyConfig } from "../../internal/upstream-proxy.js";

export { createUpstreamProxyConfig };
export const NAVION_CORE_CONFIG = {
  prefix: "/nv/",
  apiEndpoint: "/api/fetch",
  bindHost: process.env.NAVION_HOST || "0.0.0.0",
  port: parseInt(process.env.PORT || "8080", 10),
  appOrigin: process.env.NAVION_APP_ORIGIN || "http://localhost:8090",
  upstreamProxy: createUpstreamProxyConfig(process.env),
  fetch: {
    maxRedirects: 10,
    timeoutMs: 20000,
  },
  cache: {
    maxBytes: 64 * 1024 * 1024,
    ttlMs: 5 * 60 * 1000,
    entryMaxBytes: 4 * 1024 * 1024,
  },
  baseHeaders: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.5",
    "accept-encoding": "identity",
  },
};

