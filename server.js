#!/usr/bin/env node
import { createNavionCoreServer } from "./src/server/create-server.js";
import { NAVION_CORE_CONFIG } from "./src/server/config/navion.config.js";

const server = createNavionCoreServer();
const PORT = NAVION_CORE_CONFIG.port;
const HOST = NAVION_CORE_CONFIG.bindHost;

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("=".repeat(60));
  console.log("  Navion Core - Backend Engine");
  console.log("  No UI routes, API only");
  console.log("=".repeat(60));
  console.log(`  Server: http://localhost:${PORT}`);
  console.log(`  API: ${NAVION_CORE_CONFIG.apiEndpoint}`);
  console.log("  Status: /api/navion-status");
  console.log("=".repeat(60));
  console.log("  Ready as Navion-App backend core");
  console.log("=".repeat(60));
  console.log("");
});

function shutdown() {
  console.log("Navion core shutdown signal received. Closing server...");
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
