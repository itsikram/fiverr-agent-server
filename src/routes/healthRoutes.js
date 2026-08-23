import express from 'express';
import { isDatabaseConnected } from '../config/database.js';

const router = express.Router();

/**
 * GET / or /health - Health check endpoint
 */
function healthCheck(req, res) {
  const isRender = process.env.RENDER === 'true';
  const actualPort = process.env.PORT || 8765;

  let wsUrl;
  if (isRender) {
    const renderServiceUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.RENDER_SERVICE_URL ||
      'https://fiverr-agent-03vs.onrender.com';
    wsUrl = renderServiceUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://')
      .replace(/\/$/, '');
  } else {
    wsUrl = `ws://127.0.0.1:${actualPort}`;
  }

  const dbConnected = isDatabaseConnected();

  res.json({
    status: 'ok',
    message: 'MessageServer is running',
    ws: wsUrl,
    database: dbConnected ? 'connected' : 'disconnected',
  });
}

router.get('/', healthCheck);
router.get('/health', healthCheck);
router.get('/healthz', healthCheck);

export default router;
