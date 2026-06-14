import { NAVION_CORE_CONFIG } from "./config/navion.config.js";

export { handleProxy } from "../proxy.js";
export { createNavionCoreServer } from "./create-server.js";
export { createServer, startServer } from "./create-app-server.js";
export { useNavionHook } from "./pipeline/hooks.js";
export { NAVION_CORE_CONFIG } from "./config/navion.config.js";
export { NAVION_APP_SERVER_DEFAULTS } from "./config/app-server.config.js";
export { encode, decode, rewriteUrl, unrewriteUrl } from "../rewriters/url.js";
export { rewriteHtml } from "../rewriters/html.js";
export { rewriteCss } from "../rewriters/css.js";
export { rewriteJs } from "../rewriters/js.js";

export const NAVION_VERSION = "1.0.0";

export function getNavionCoreRuntime() {
  return {
    name: "Navion",
    layer: "core",
    version: NAVION_VERSION,
    prefix: NAVION_CORE_CONFIG.prefix,
    apiEndpoint: NAVION_CORE_CONFIG.apiEndpoint,
    host: NAVION_CORE_CONFIG.bindHost,
    port: NAVION_CORE_CONFIG.port,
  };
}
