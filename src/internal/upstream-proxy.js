import net from "node:net";
import tls from "node:tls";

const AUTO_PROXY_CANDIDATES = [
  "socks5://127.0.0.1:1080",
  "socks5://127.0.0.1:9050",
  "socks5://127.0.0.1:9150",
  "http://127.0.0.1:7890",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8888",
  "http://127.0.0.1:3128",
];

const DEFAULT_BLOCKED_HOSTS = [
  "pornhub.com",
  "*.pornhub.com",
  "phncdn.com",
  "*.phncdn.com",
  "phprcdn.com",
  "*.phprcdn.com",
  "trafficjunky.net",
  "*.trafficjunky.net",
  "hanime.tv",
  "*.hanime.tv",
  "hstream.moe",
  "*.hstream.moe",
  "xvideos.com",
  "*.xvideos.com",
  "xhamster.com",
  "*.xhamster.com",
  "eporner.com",
  "*.eporner.com",
  "redtube.com",
  "*.redtube.com",
  "spankbang.com",
  "*.spankbang.com",
  "xnxx.com",
  "*.xnxx.com",
];

let cachedAutoProxy = null;
let autoProxyProbePromise = null;

function parseProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const scheme = url.protocol.replace(":", "").toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5" && scheme !== "socks4") return null;
    return {
      scheme,
      hostname: url.hostname,
      port: parseInt(url.port, 10) || (scheme === "http" || scheme === "https" ? 8080 : 1080),
      username: url.username ? decodeURIComponent(url.username) : "",
      password: url.password ? decodeURIComponent(url.password) : "",
      raw,
    };
  } catch {
    return null;
  }
}

function hostMatchesPattern(hostname, pattern) {
  const host = String(hostname || "").toLowerCase();
  const rule = String(pattern || "").trim().toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) || host === rule.slice(2);
  }
  return host === rule;
}

function parseHostRules(value) {
  const raw = String(value || "").trim();
  if (!raw) return [...DEFAULT_BLOCKED_HOSTS];
  if (raw === "*") return ["*"];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

export function createUpstreamProxyConfig(env = process.env) {
  const url = String(env.NAVION_UPSTREAM_PROXY || "").trim();
  const hosts = parseHostRules(env.NAVION_UPSTREAM_PROXY_HOSTS);
  const all = String(env.NAVION_UPSTREAM_PROXY_ALL || "").trim() === "1";
  const auto = String(env.NAVION_UPSTREAM_PROXY_AUTO || "").trim() === "1";
  return {
    url,
    proxy: parseProxyUrl(url),
    hosts,
    all,
    auto,
  };
}

export function isKnownBlockedHost(hostname, config) {
  if (!config) return false;
  const host = String(hostname || "").toLowerCase();
  return config.hosts.some((pattern) => hostMatchesPattern(host, pattern));
}

export function shouldUseUpstreamProxy(hostname, config) {
  if (!config) return false;
  if (config.all && config.proxy) return true;
  if (!config.proxy && !config.auto) return false;
  if (config.hosts.includes("*")) return Boolean(config.proxy);
  return isKnownBlockedHost(hostname, config);
}

function readUntilHeaders(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Proxy handshake timed out"));
    }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      cleanup();
      const headerText = buf.slice(0, idx).toString("utf8");
      const rest = buf.slice(idx + 4);
      if (rest.length) socket.unshift(rest);
      resolve(headerText);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function readExact(socket, length, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Proxy read timed out"));
    }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < length) return;
      cleanup();
      const rest = buf.slice(length);
      if (rest.length) socket.unshift(rest);
      resolve(buf.slice(0, length));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function connectTcp(proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: proxy.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Proxy connect timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new Error("Proxy socket timed out"));
      });
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function socks5Connect(proxy, targetHost, targetPort, timeoutMs) {
  const socket = await connectTcp(proxy, timeoutMs);
  const hasAuth = Boolean(proxy.username);
  const greeting = Buffer.from([0x05, 0x01, hasAuth ? 0x02 : 0x00]);
  socket.write(greeting);
  const methodReply = await readExact(socket, 2, timeoutMs);
  if (methodReply[0] !== 0x05) throw new Error("Invalid SOCKS5 greeting");
  if (methodReply[1] === 0x02 && hasAuth) {
    const userBuf = Buffer.from(proxy.username, "utf8");
    const passBuf = Buffer.from(proxy.password || "", "utf8");
    const auth = Buffer.alloc(3 + userBuf.length + passBuf.length);
    auth[0] = 0x01;
    auth[1] = userBuf.length;
    userBuf.copy(auth, 2);
    auth[2 + userBuf.length] = passBuf.length;
    passBuf.copy(auth, 3 + userBuf.length);
    socket.write(auth);
    const authReply = await readExact(socket, 2, timeoutMs);
    if (authReply[1] !== 0x00) throw new Error("SOCKS5 auth failed");
  } else if (methodReply[1] !== 0x00) {
    throw new Error("SOCKS5 method rejected");
  }
  const hostBuf = Buffer.from(targetHost, "utf8");
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05;
  req[1] = 0x01;
  req[2] = 0x00;
  req[3] = 0x03;
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(targetPort, 5 + hostBuf.length);
  socket.write(req);
  const head = await readExact(socket, 4, timeoutMs);
  if (head[1] !== 0x00) throw new Error("SOCKS5 connect failed");
  if (head[3] === 0x01) await readExact(socket, 6, timeoutMs);
  else if (head[3] === 0x03) {
    const lenBuf = await readExact(socket, 1, timeoutMs);
    await readExact(socket, lenBuf[0] + 2, timeoutMs);
  } else if (head[3] === 0x04) await readExact(socket, 18, timeoutMs);
  return socket;
}

async function httpConnect(proxy, targetHost, targetPort, timeoutMs) {
  const socket = await connectTcp(proxy, timeoutMs);
  let authLine = "";
  if (proxy.username) {
    const token = Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64");
    authLine = `Proxy-Authorization: Basic ${token}\r\n`;
  }
  socket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authLine}\r\n`
  );
  const headers = await readUntilHeaders(socket, timeoutMs);
  const statusLine = headers.split("\r\n")[0] || "";
  if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
    socket.destroy();
    throw new Error(`HTTP proxy CONNECT failed: ${statusLine}`);
  }
  return socket;
}

function wrapTls(socket, servername) {
  return tls.connect({
    socket,
    servername,
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
  });
}

export async function connectThroughUpstreamProxy(proxy, targetHost, targetPort, isHttps, timeoutMs = 15000) {
  if (!proxy) throw new Error("Missing upstream proxy");
  let socket;
  if (proxy.scheme === "socks5" || proxy.scheme === "socks4") {
    socket = await socks5Connect(proxy, targetHost, targetPort, timeoutMs);
  } else {
    socket = await httpConnect(proxy, targetHost, targetPort, timeoutMs);
  }
  if (isHttps) return wrapTls(socket, targetHost);
  return socket;
}

async function probeProxyCandidate(candidate, probeHost, timeoutMs) {
  const proxy = parseProxyUrl(candidate);
  if (!proxy) return null;
  try {
    const socket = await connectThroughUpstreamProxy(proxy, probeHost, 443, true, timeoutMs);
    socket.destroy();
    return proxy;
  } catch {
    return null;
  }
}

export async function discoverUpstreamProxy(config, probeHost = "example.com", timeoutMs = 2500) {
  if (cachedAutoProxy) return cachedAutoProxy;
  if (!config?.auto) return null;
  if (config.proxy) {
    cachedAutoProxy = config.proxy;
    return cachedAutoProxy;
  }
  if (!autoProxyProbePromise) {
    autoProxyProbePromise = (async () => {
      for (const candidate of AUTO_PROXY_CANDIDATES) {
        const found = await probeProxyCandidate(candidate, probeHost, timeoutMs);
        if (found) {
          cachedAutoProxy = found;
          return found;
        }
      }
      return null;
    })();
  }
  return autoProxyProbePromise;
}

export async function resolveUpstreamProxyForHost(hostname, config, options = {}) {
  if (!config) return null;
  if (config.proxy && (config.all || shouldUseUpstreamProxy(hostname, config))) {
    return config.proxy;
  }
  if (config.auto && shouldUseUpstreamProxy(hostname, config)) {
    return discoverUpstreamProxy(config, options.probeHost || hostname, options.timeoutMs);
  }
  return null;
}

export function resetUpstreamProxyCache() {
  cachedAutoProxy = null;
  autoProxyProbePromise = null;
}

export const __upstreamProxyTestInternals = {
  hostMatchesPattern,
  parseHostRules,
  parseProxyUrl,
  AUTO_PROXY_CANDIDATES,
  DEFAULT_BLOCKED_HOSTS,
};
