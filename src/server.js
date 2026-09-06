#!/usr/bin/env node
/**
 * Express-based MessageServer
 * Provides REST API for Fiverr Agent browser extension
 */

import './config/env.js';
import { createApp, attachWebSocketServer } from './app.js';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database.js';
import { MessageServer } from './services/MessageServerService.js';
import { checkPortAvailable, findProcessUsingPort, getKillPortCommand } from '../utils/serverUtils.js';
import http from 'http';

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
  const isProd = process.env.RENDER === 'true' || (process.env.PORT && process.env.PORT.trim() !== '');
  const envName = isProd ? 'prod' : 'dev';

  console.log('');
  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║ 🚀 Fiverr Agent Message Server         ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log('');
  console.log(`[Server] Starting in ${envName} mode on port ${port}`);

  // Connect to database
  const dbConnected = await connectDatabase();
  if (!dbConnected) {
    console.warn('[Server] ⚠️  Continuing without database. API endpoints may not work properly.');
    console.warn('[Server] ⚠️  To use this server, start MongoDB: mongod');
  }

  // Create Express app
  const app = createApp();

  // Create HTTP server
  const httpServer = http.createServer(app);

  // Create MessageServer instance (for WebSocket handling)
  const messageServer = new MessageServer(port, httpServer);

  // Attach WebSocket server
  attachWebSocketServer(httpServer, messageServer);

  // Start HTTP server
  await new Promise((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`[Server] ✓ Listening on port ${port}`);
      resolve();
    });
  });

  // Health check
  let healthOk = false;
  const healthUrl = `http://127.0.0.1:${port}/health`;

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
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
        console.log('[Server] ✓ Health check passed');
        break;
      }
    } catch (error) {
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  if (!healthOk) {
    console.warn('[Server] ⚠️  Health check warnings (server may still be functional)');
  }

  // Graceful shutdown
  let shutdownDone = false;

  function shutdown(signal) {
    if (shutdownDone) {
      process.exit(1);
    }
    shutdownDone = true;

    console.log('[Server] ⏹️  Shutting down (${signal})');

      httpServer.close(() => {
        console.log('[Server] ✓ HTTP server closed');
      });

      disconnectDatabase().then(() => {
        console.log('[Server] ✓ Shutdown complete');
        process.exit(0);
      });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.warn('[Server] ⚠️  Forced exit after timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Monitor server health (optional - don't exit if DB is down)
  setInterval(() => {
    if (!isDatabaseConnected() && dbConnected) {
      console.warn('[Server] ⚠️  Database connection lost');
    }
  }, 30000);
}

// Run main
main().catch((error) => {
  console.error('[Server] Fatal error:', error.message);
  console.error(error);
  process.exit(1);
});
