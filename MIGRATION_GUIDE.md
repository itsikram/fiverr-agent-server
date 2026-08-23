# Migration Guide: Express + Mongoose Refactor

This guide explains the refactoring from raw Node.js HTTP server to Express.js with Mongoose ORM.

## What Changed

### Before (Legacy)
```
server.js (raw http.createServer)
  ├── Inline route handlers
  ├── Direct MongoDB driver
  └── Manual connection management
```

### After (Express + Mongoose)
```
src/
├── app.js (Express setup)
├── server.js (entry point)
├── models/ (Mongoose schemas)
├── controllers/ (business logic)
├── routes/ (endpoint definitions)
└── middleware/ (auth, logging)
```

## Key Improvements

### 1. Database Access
**Before:**
```javascript
const coll = await this.getMongoUsersCollection();
const user = coll.findOne({ email });
```

**After:**
```javascript
const user = await User.findOne({ email });
```

### 2. Authentication
**Before:**
```javascript
async requireAdmin(req, res, token) {
  const user = await this.getUserByToken(token);
  if (!user) {
    return this.sendJsonResponse(res, 401, { error: 'Missing auth token' });
  }
  if (user.role !== 'admin') {
    return this.sendJsonResponse(res, 403, { error: 'Admin access required' });
  }
}
```

**After:**
```javascript
export async function requireAdmin(req, res, next) {
  const user = await verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Missing auth token' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.user = user;
  next();
}
```

### 3. Route Handling
**Before:**
```javascript
if (pathname === "/admin/users") {
  (async () => {
    try {
      const user = await this.requireAdmin(req, res, token);
      // ... logic
    } catch (error) {
      // error handling
    }
  })();
}
```

**After:**
```javascript
router.get('/users', requireAdmin, (req, res) => {
  const users = await User.find({});
  res.json({ users });
});
```

## Running Both Servers

During migration, you can run both:

```bash
# New Express server (recommended)
npm start

# Legacy server (for comparison)
npm run legacy
```

## Database Configuration

Update your `.env` file:

```env
# MongoDB connection
MONGO_URL=mongodb://localhost:27017
MONGO_DB_NAME=fiverr-agent

# Server
PORT=8765
RENDER=false

# Logging
HTTP_LOG_FILE=false

# Push notifications
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

## Testing Migration

### 1. Health Check
```bash
curl http://localhost:8765/health
```

Expected response:
```json
{
  "status": "ok",
  "message": "MessageServer is running",
  "ws": "ws://127.0.0.1:8765",
  "database": "connected"
}
```

### 2. Register User
```bash
curl -X POST http://localhost:8765/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","username":"testuser","password":"password123"}'
```

### 3. Login
```bash
curl -X POST http://localhost:8765/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}'
```

Response includes `token` - use for authenticated requests:
```bash
curl http://localhost:8765/auth/me \
  -H "Authorization: Bearer <token>"
```

## Gradual Migration Steps

If the server is already running in production:

### Phase 1: Parallel Running
- Keep legacy server running on original port
- Run new Express server on different port (8766)
- Test Express endpoints separately
- Copy data between databases if needed

### Phase 2: Client Switching
- Update clients/extensions to use new endpoints
- Monitor logs for issues
- Verify all features work

### Phase 3: Legacy Shutdown
- Disable legacy server
- Remove old code after verification

## Common Issues

### Issue: "Module not found"
Make sure you're running from the project root:
```bash
cd fiverr-server
npm start
```

### Issue: MongoDB connection fails
Check `.env` file has correct `MONGO_URL`:
```bash
# Test MongoDB connection
mongosh "mongodb://localhost:27017"
```

### Issue: Express not found
Install dependencies:
```bash
npm install
```

### Issue: Port already in use
Either:
1. Kill the process using the port
2. Change the port in `.env`

## API Compatibility

All original REST endpoints are preserved:
- ✅ `/auth/*` - Authentication
- ✅ `/admin/*` - Admin endpoints
- ✅ `/clients` - Client list
- ✅ `/activities` - Activity logging
- ✅ `/health` - Health check
- ✅ `/push/*` - Push notifications
- ✅ WebSocket at `/`

## Breaking Changes

None! The new server maintains full backward compatibility with the legacy API.

## Performance Improvements

1. **Database Queries**: Mongoose indexes improve query speed
2. **Connection Pooling**: Mongoose manages connection pool
3. **Validation**: Schema validation prevents invalid data
4. **Logging**: Structured logging for debugging

## Code Examples

### Adding a New Endpoint

1. Create controller (`src/controllers/featureController.js`):
```javascript
export async function getFeature(req, res) {
  try {
    const result = await Feature.find({});
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

2. Create model (`src/models/Feature.js`):
```javascript
import mongoose from 'mongoose';
const schema = new mongoose.Schema({ name: String });
export const Feature = mongoose.model('Feature', schema);
```

3. Create route (`src/routes/featureRoutes.js`):
```javascript
import express from 'express';
import { getFeature } from '../controllers/featureController.js';
const router = express.Router();
router.get('/', getFeature);
export default router;
```

4. Mount in `src/app.js`:
```javascript
app.use('/features', featureRoutes);
```

## Support

For issues during migration:
1. Check server logs: `npm start`
2. Review STRUCTURE.md for architecture
3. Check MongoDB connection: `mongosh`
4. Verify `.env` configuration
