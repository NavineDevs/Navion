import { NAVION_CORE_CONFIG } from "./config/navion.config.js";

export { handleProxy } from "../proxy.js";
export { useNavionHook } from "./pipeline/hooks.js";
export { NAVION_CORE_CONFIG } from "./config/navion.config.js";

export function getNavionCoreRuntime() {
  return {
    name: "Navion",
    layer: "core",
    version: "4.0.0",
    prefix: NAVION_CORE_CONFIG.prefix,
    apiEndpoint: NAVION_CORE_CONFIG.apiEndpoint,
    host: NAVION_CORE_CONFIG.bindHost,
    port: NAVION_CORE_CONFIG.port,
  };
}

