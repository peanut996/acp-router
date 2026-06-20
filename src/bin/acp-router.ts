#!/usr/bin/env node
import { startMcpServer } from "../server.js";

startMcpServer().catch((error: Error) => {
  process.stderr.write(`acp-router: ${error.message}\n`);
  process.exit(1);
});
