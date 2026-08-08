#!/usr/bin/env node
/**
 * Standalone runner for MessageServer (e.g. on Render.com).
 * - Dev: no PORT/RENDER → uses port 8765, http://localhost:8765/health
 * - Prod: RENDER=true or PORT set → uses PORT from env (e.g. Render).
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MessageServer } from './MessageServer.js';
import { checkPortAvailable, findProcessUsingPort, getKillPortCommand } from './utils/serverUtils.js';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the server project root
const envPath = join(__dirname, '.env');
dotenv.config({ path: envPath });

/**
 * Get port from environment
 */
function getPort() {
  if (process.env.RENDER === 'true') {
    return parseInt(process.env.PORT || '10000');
  }
  return parseInt(process.env.PORT || '8765');
}

/**
 * Main function
 */
async function main() {
  const port = getPort();
  const isProd = process.env.RENDER === 'true' || process.env.PORT && process.env.PORT.trim() !== '';
  const envName = isProd ? 'prod' : 'dev';



  const server = new MessageServer(port);
  server.start();

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 1200));

  if (!server.isRunning()) {

    const pid = await findProcessUsingPort(port);



    const cmd = getKillPortCommand(port);
    if (cmd) {


    }



    process.exit(1);
  }

  const actualPort = server.port;
  const healthUrlLocal = `http://localhost:${actualPort}/health`;
  const healthUrl127 = `http://127.0.0.1:${actualPort}/health`;

  // Retry health check
  let healthOk = false;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get(healthUrl127, { timeout: 2000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {body += chunk;});
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });

      if (response.statusCode === 200) {
        healthOk = true;

        break;
      }
    } catch (error) {
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {

      }
    }
  }




  // Graceful shutdown
  let shutdownDone = false;

  function shutdown(signal) {
    if (shutdownDone) {
      // Second Ctrl+C: force exit
      process.exit(1);
    }
    shutdownDone = true;

    server.stop();

    // Force exit after a short delay
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep process alive
  setInterval(() => {
    if (!server.isRunning()) {

      process.exit(1);
    }
  }, 1000);
}

// Run main
main().catch((error) => {


  process.exit(1);
});