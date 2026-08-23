/**
 * HTTP Request Logger
 * Logs all incoming HTTP requests with method, path, status code, and response time
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Optional: file-based logging (disabled by default)
const ENABLE_FILE_LOGGING = process.env.HTTP_LOG_FILE === 'true';
const LOG_FILE = path.join(path.dirname(__dirname), 'http-requests.log');

/**
 * Get client IP address from request
 */
export function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/**
 * Format bytes for display
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + sizes[i];
}

/**
 * Log HTTP request with details
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} startTime - Timestamp when request started
 * @param {boolean} isWebSocket - Whether this is a WebSocket upgrade request
 */
export function logHttpRequest(req, res, startTime, isWebSocket = false) {
  const duration = Date.now() - startTime;
  const clientIp = getClientIp(req);
  const method = req.method || 'UNKNOWN';
  const pathname = req.url || '/';
  const statusCode = isWebSocket ? 'WS' : (res.statusCode || 0);
  const contentLength = res.getHeader('content-length') || 0;
  const userAgent = req.headers['user-agent'] || '-';

  // Color codes for terminal output
  let statusColor = '\x1b[32m'; // Green for 2xx
  if (!isWebSocket) {
    if (statusCode >= 400) statusColor = '\x1b[31m'; // Red for 4xx/5xx
    else if (statusCode >= 300) statusColor = '\x1b[33m'; // Yellow for 3xx
  } else {
    statusColor = '\x1b[36m'; // Cyan for WebSocket
  }

  const resetColor = '\x1b[0m';

  const logEntry = [
    `[${new Date().toISOString()}]`,
    `${clientIp}`,
    `${method}`,
    pathname,
    `${statusColor}${statusCode}${resetColor}`,
    `${duration}ms`,
    formatBytes(parseInt(contentLength) || 0),
    userAgent === '-' ? '-' : `"${userAgent.substring(0, 50)}"`
  ].join(' ');

  console.log(logEntry);

  // Optional: Write to file
  if (ENABLE_FILE_LOGGING) {
    const plainLogEntry = `[${new Date().toISOString()}] ${clientIp} ${method} ${pathname} ${statusCode} ${duration}ms ${formatBytes(parseInt(contentLength) || 0)} ${userAgent === '-' ? '-' : userAgent.substring(0, 50)}\n`;
    try {
      fs.appendFileSync(LOG_FILE, plainLogEntry);
    } catch (err) {
      // Silently fail if file logging fails
    }
  }
}

/**
 * Create HTTP logger middleware that wraps request/response
 * Usage: Apply before your http server request handler
 */
export function createHttpLoggerMiddleware() {
  return (req, res, next) => {
    const startTime = Date.now();

    // Wrap res.writeHead to capture status code
    const originalWriteHead = res.writeHead;
    res.writeHead = function(statusCode, ...args) {
      res.statusCode = statusCode;
      return originalWriteHead.apply(res, [statusCode, ...args]);
    };

    // Wrap res.end to log after response is complete
    const originalEnd = res.end;
    res.end = function(...args) {
      logHttpRequest(req, res, startTime);
      return originalEnd.apply(res, args);
    };

    if (next) next();
  };
}

/**
 * Wrap an http.createServer handler with logging
 */
export function withHttpLogging(handler) {
  return (req, res) => {
    const startTime = Date.now();

    // Wrap res.writeHead to capture status code
    const originalWriteHead = res.writeHead;
    res.writeHead = function(statusCode, ...args) {
      res.statusCode = statusCode;
      return originalWriteHead.apply(res, [statusCode, ...args]);
    };

    // Wrap res.end to log after response is complete
    const originalEnd = res.end;
    res.end = function(...args) {
      logHttpRequest(req, res, startTime);
      return originalEnd.apply(res, args);
    };

    // Call the handler
    handler(req, res);
  };
}

/**
 * Log WebSocket upgrade request
 */
export function logWebSocketUpgrade(req) {
  const startTime = Date.now();
  const duration = Date.now() - startTime;
  const clientIp = getClientIp(req);
  const userAgent = req.headers['user-agent'] || '-';

  const logEntry = [
    `[${new Date().toISOString()}]`,
    `${clientIp}`,
    'UPGRADE',
    req.url || '/',
    '\x1b[36mWS\x1b[0m', // Cyan for WebSocket
    `${duration}ms`,
    '-',
    userAgent === '-' ? '-' : `"${userAgent.substring(0, 50)}"`
  ].join(' ');

  console.log(logEntry);
}
