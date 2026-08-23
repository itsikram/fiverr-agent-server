# Quick Start Guide - Express + Mongoose Server

## Installation

```bash
cd fiverr-server
npm install
```

## Configuration

Create/update `.env` file:

```env
# MongoDB
MONGO_URL=mongodb://localhost:27017
MONGO_DB_NAME=fiverr-agent

# Server
PORT=8765
RENDER=false

# Optional: Enable file-based logging
HTTP_LOG_FILE=false

# Push Notifications (optional)
VAPID_PUBLIC_KEY=your-key-here
VAPID_PRIVATE_KEY=your-key-here
```

## Start Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start

# Legacy server (old version)
npm run legacy
```

Server will start on `http://localhost:8765`

## Test Basic Endpoints

### Health Check
```bash
curl http://localhost:8765/health
```

Expected:
```json
{
  "status": "ok",
  "message": "MessageServer is running",
  "ws": "ws://127.0.0.1:8765",
  "database": "connected"
}
```

### Register User
```bash
curl -X POST http://localhost:8765/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "username": "john",
    "password": "secure-password"
  }'
```

Response:
```json
{
  "success": true,
  "token": "your-token-here",
  "username": "john",
  "email": "user@example.com",
  "role": "user"
}
```

### Login
```bash
curl -X POST http://localhost:8765/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "secure-password"
  }'
```

Save the `token` from response.

### Get Current User
```bash
curl http://localhost:8765/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Get Clients
```bash
curl http://localhost:8765/clients \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Get User Assignments
```bash
curl http://localhost:8765/clients/me/assignments \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Record Activity
```bash
curl -X POST http://localhost:8765/activities \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
    "type": "login",
    "data": {
      "browser": "Chrome",
      "ip": "127.0.0.1"
    }
  }'
```

## Server Logs

Console will show:
```
[Server] Starting in dev mode on port 8765
[Database] Connected to MongoDB: fiverr-agent
[Server] Listening on port 8765
[Server] Health check passed

[2026-08-23T10:30:45.123Z] 127.0.0.1 GET /health 200 5ms 85B "curl/8.19.0"
[2026-08-23T10:30:46.456Z] 127.0.0.1 POST /auth/login 200 45ms 150B "curl/8.19.0"
```

## File Structure

```
src/
├── app.js                 - Express setup
├── server.js              - Entry point
├── config/database.js     - DB connection
├── models/                - Mongoose schemas (7 models)
├── controllers/           - Business logic (4 controllers)
├── routes/                - API routes (6 route files)
└── middleware/            - Auth & logging (2 middleware)
```

## API Routes Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | ✗ | Register new user |
| POST | `/auth/login` | ✗ | Login user |
| GET | `/auth/me` | ✓ | Get current user |
| POST | `/auth/logout` | ✓ | Logout |
| GET | `/clients` | ✓ | List clients |
| GET | `/clients/me/assignments` | ✓ | Get assignments |
| POST | `/activities` | ✓ | Record activity |
| GET | `/activities` | ✓ | Get activities |
| GET | `/health` | ✗ | Health check |
| GET | `/push/vapid-public-key` | ✗ | VAPID key |
| GET | `/admin/users` | ✓ Admin | List users |
| GET | `/admin/clients` | ✓ Admin | List clients |
| POST | `/admin/assignments` | ✓ Admin | Set assignments |
| GET | `/admin/activities` | ✓ Admin | Get activities |

## Troubleshooting

### Port Already in Use
```bash
# Kill process on port 8765
lsof -ti:8765 | xargs kill -9

# Or use different port
PORT=8766 npm start
```

### MongoDB Connection Failed
```bash
# Check MongoDB is running
mongosh

# Verify MONGO_URL in .env
# Default: mongodb://localhost:27017
```

### Module Not Found Error
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Express Not Found
```bash
# Check package.json has express dependency
cat package.json | grep express

# If missing, add it
npm install express
```

## Development Tips

### Auto-reload on File Changes
```bash
npm run dev
```

### Debug Specific Routes
Add `console.log` in controller:
```javascript
export async function login(req, res) {
  console.log('Login request:', req.body);
  // ...
}
```

### View Database Records
```bash
mongosh
use fiverr-agent
db.users.find().pretty()
db.clients.find().pretty()
db.messages.find().pretty()
```

### Check HTTP Request