import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENABLE_FILE_LOGGING = process.env.HTTP_LOG_FILE === 'true';
const LOG_FILE = path.join(path.dirname(path.dirname(__dirname)), 'http-requests.log');

/**
 * Get client IP address
 */
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.ip ||
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
 * HTTP request logging middleware for Express
 */
export function httpLogger(req, res, next) {
  const startTime = Date.now();
  const clientIp = getClientIp(req);
  const method = req.method;
  const path = req.originalUrl || req.url;
  const userAgent = req.headers['user-agent'] || '-';

  // Intercept res.send, res.json, res.end
  const originalSend = res.send;
  const originalJson = res.json;
  const originalEnd = res.end;

  res.send = function(data) {
    res.send = originalSend;
    return res.send(data);
  };

  res.json = function(data) {
    res.json = originalJson;
    return res.json(data);
  };

  res.end = function(...args) {
    res.end = originalEnd;

    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    const contentLength = res.get('content-length') || 0;

    // Color codes
    let statusColor = '\x1b[32m'; // Green
    if (statusCode >= 400) statusColor = '\x1b[31m'; // Red
    else if (statusCode >= 300) statusColor = '\x1b[33m'; // Yellow
    const resetColor = '\x1b[0m';

    const logEntry = [
      `[${new Date().toISOString()}]`,
      clientIp,
      method,
      path,
      `${statusColor}${statusCode}${resetColor}`,
      `${duration}ms`,
      formatBytes(parseInt(contentLength) || 0),
      userAgent === '-' ? '-' : `"${userAgent.substring(0, 50)}"`,
    ].join(' ');

    console.log(logEntry);

    // Optional file logging
    if (ENABLE_FILE_LOGGING) {
      const plainLogEntry = `[${new Date().toISOString()}] ${clientIp} ${method} ${path} ${statusCode} ${duration}ms ${formatBytes(parseInt(contentLength) || 0)} ${userAgent === '-' ? '-' : userAgent.substring(0, 50)}\n`;
      try {
        fs.appendFileSync(LOG_FILE, plainLogEntry);
      } catch (err) {
        // Silently fail
      }
    }

    return res.end(...args);
  };

  next();
}
