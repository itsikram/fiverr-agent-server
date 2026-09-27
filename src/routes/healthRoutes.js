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

  const counts = { expo: 0, browser: 0, other: 0 };
  const legacy = req.app?.locals?.messageServer;
  if (legacy?.connectedClients) {
    for (const [sessionId, sock] of legacy.connectedClients.entries()) {
      if (!sock || sock.readyState !== 1) continue;
      const type = legacy.clientTypes.get(sessionId);
      if (type === 'expo') counts.expo += 1;
      else if (type === 'browser') counts.browser += 1;
      else counts.other += 1;
    }
  }

  res.json({
    status: 'ok',
    message: 'MessageServer is running',
    ws: wsUrl,
    database: dbConnected ? 'connected' : 'disconnected',
    // Lets you confirm which deploy is live and who is connected.
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
    uptimeSeconds: Math.round(process.uptime()),
    connections: {
      apps: counts.expo,
      extensions: counts.browser,
      other: counts.other,
    },
  });
}

router.get('/', healthCheck);
router.get('/health', healthCheck);
router.get('/healthz', healthCheck);

export default router;
