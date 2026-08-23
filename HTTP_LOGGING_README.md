# HTTP Request Logging

The server now includes comprehensive HTTP request logging for monitoring and debugging.

## Log Format

```
[ISO_TIMESTAMP] CLIENT_IP METHOD PATH STATUS_CODE DURATION RESPONSE_SIZE USER_AGENT
```

### Example Log Output

```
[2026-08-23T09:11:25.952Z] 127.0.0.1 GET /health 200 3ms 79B "Mozilla/5.0..."
[2026-08-23T09:11:28.245Z] 127.0.0.1 GET /nonexistent 404 0ms 0B "curl/8.19.0"
[2026-08-23T09:11:25.962Z] 127.0.0.1 UPGRADE / WS 0ms - "Mozilla/5.0..."
```

## What Gets Logged

- **HTTP Requests**: All GET, POST, PUT, DELETE, OPTIONS requests
- **WebSocket Upgrades**: Upgrade requests are logged with `UPGRADE` method and `WS` status
- **Response Details**: Status code, response time, content length
- **Client Info**: IP address (with X-Forwarded-For support), User-Agent header

## Color Coding (Console Output)

- **Green (2xx)**: Successful responses
- **Yellow (3xx)**: Redirects
- **Red (4xx/5xx)**: Client and server errors
- **Cyan (WS)**: WebSocket upgrades

## Monitored Endpoints

The following endpoints are automatically logged:

### Authentication
- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `GET /auth/me` - Get current user
- `POST /auth/logout` - User logout

### Data Endpoints
- `GET /health` - Health check
- `GET /` - Root endpoint
- `GET /clients` - Get client list
- `GET /push/vapid-public-key` - VAPID public key

### Admin Endpoints
- `GET /admin/clients` - Admin client list
- `PUT /admin/clients/:id` - Update client
- `GET /admin/messages` - Admin message list
- `PUT /admin/messages/:id` - Update message
- `GET /admin/users` - List users
- `PUT /admin/assignments` - Set user assignments
- `GET /admin/activities` - Activity logs

### WebSocket
- WebSocket upgrade at `/` with status `WS`

## Optional File Logging

To enable logging to a file (`http-requests.log`), set the environment variable:

```bash
export HTTP_LOG_FILE=true
npm start
```

The log file will be created in the project root directory with plain text format (no color codes).

## Implementation Details

### Files Modified

1. **`utils/httpLogger.js`** (new)
   - `logHttpRequest()` - Core logging function
   - `withHttpLogging()` - Wraps HTTP handlers with logging
   - `logWebSocketUpgrade()` - Logs WebSocket connections
   - `getClientIp()` - Extracts client IP from request
   - `formatBytes()` - Formats response sizes

2. **`MessageServer.js`**
   - Updated `createHttpServer()` to use `withHttpLogging()` wrapper
   - Updated WebSocket connection handler to call `logWebSocketUpgrade()`

### How It Works

The logging is implemented by wrapping the `res.writeHead()` and `res.end()` methods to capture:
- Status code (from `writeHead`)
- Response size (from `content-length` header)
- Response time (duration between request start and end)

This allows accurate logging of all HTTP requests including edge cases and streaming responses.

## Performance Impact

- Minimal overhead: simple timing and method wrapping
- No serialization of request/response bodies
- Optional file I/O (disabled by default)
- Thread-safe console output

## Example Usage

Check your server logs to debug:

```bash
npm start
# Logs appear in real-time:
# [2026-08-23T09:11:25.952Z] 127.0.0.1 GET /health 200 3ms 79B "..."
```

Monitor specific endpoints:

```bash
npm start | grep "admin/"
```

Watch for errors:

```bash
npm start | grep -E "\[4|5\]"
```
