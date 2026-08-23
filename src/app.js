import express from 'express';
import { WebSocketServer } from 'ws';
import { httpLogger } from './middleware/httpLogger.js';
import healthRoutes from './routes/healthRoutes.js';
import authRoutes from './routes/authRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import activityRoutes from './routes/activityRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import { authenticate } from './middleware/auth.js';
import { getMyAssignments } from './controllers/clientController.js';

/**
 * Create Express application
 */
export function createApp() {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
  app.use(httpLogger);

  // Disable ETags globally to prevent 304 caching
  app.set('etag', false);

  // Set cache headers for admin and auth endpoints
  app.use((req, res, next) => {
    if (req.path.startsWith('/admin') || req.path.startsWith('/auth')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
    next();
  });



  // CORS headers
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }

    next();
  });

  // Routes
  app.use('/', healthRoutes);
  app.use('/auth', authRoutes);
  // Mount /me/assignments at top level for backward compatibility with client expectations
  app.get('/me/assignments', authenticate, getMyAssignments);
  app.use('/clients', clientRoutes);
  app.use('/admin', adminRoutes);
  app.use('/activities', activityRoutes);
  app.use('/push', pushRoutes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[Express] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Attach WebSocket server to Express HTTP server
 */
export function attachWebSocketServer(httpServer, messageServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    perMessageDeflate: false,
    clientTracking: true,
  });

  wss.on('connection', (ws, req) => {
    messageServer.handleWebSocketConnection(ws, req);
  });

  wss.on('error', (error) => {
    console.error('[WebSocket] Error:', error.message);
  });

  return wss;
}
