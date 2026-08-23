# Server Architecture

This document describes the refactored server structure using Express.js and Mongoose.

## Directory Structure

```
src/
├── app.js                 # Express application setup
├── server.js              # Main entry point
├── config/
│   └── database.js        # MongoDB/Mongoose connection
├── models/
│   ├── index.js           # Model exports
│   ├── User.js            # User schema
│   ├── Client.js          # Client schema
│   ├── Message.js         # Message schema
│   ├── Assignment.js      # User-client assignment schema
│   ├── Activity.js        # Activity log schema
│   ├── SellerProfile.js   # Seller profile schema
│   └── WebPushSubscription.js # Push subscription schema
├── controllers/
│   ├── authController.js      # Authentication endpoints
│   ├── adminController.js     # Admin panel endpoints
│   ├── clientController.js    # Client management endpoints
│   └── activityController.js  # Activity logging endpoints
├── routes/
│   ├── authRoutes.js          # POST /auth/*
│   ├── clientRoutes.js        # GET /clients
│   ├── adminRoutes.js         # /admin/*
│   ├── activityRoutes.js      # /activities
│   ├── healthRoutes.js        # GET /health
│   └── pushRoutes.js          # /push/*
├── middleware/
│   ├── auth.js                # Authentication & authorization
│   └── httpLogger.js          # HTTP request logging
├── services/
│   └── MessageServerService.js # WebSocket handler
└── utils/
    └── (existing utilities)
```

## Flow Diagram

```
Request → Express App → Middleware (CORS, Logging, Auth) → Routes → Controllers → Models → Database
```

## Key Components

### Express App (`src/app.js`)
- Sets up Express server
- Configures middleware (JSON parsing, CORS, logging)
- Mounts all routes
- Handles errors

### Database (`src/config/database.js`)
- Mongoose connection management
- Connection pooling
- Database health checks

### Models (`src/models/*.js`)
- Mongoose schemas for all entities
- Indexes for performance
- Data validation

### Controllers (`src/controllers/*.js`)
- Business logic for each feature
- Request validation
- Response formatting

### Routes (`src/routes/*.js`)
- Express route definitions
- Middleware application
- Request routing to controllers

### Middleware (`src/middleware/*.js`)
- Authentication (token verification)
- Authorization (role-based access)
- HTTP request logging with colors

## Authentication Flow

```
Request
  ↓
Extract Token from Authorization Header
  ↓
Query Database for User with Valid Token
  ↓
Attach User Object to req.user
  ↓
Continue to Route Handler
  ↓
(If no valid token: return 401 Unauthorized)
```

## API Endpoints

### Authentication (`/auth`)
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login and get token
- `GET /auth/me` - Get current user (requires auth)
- `POST /auth/logout` - Logout (requires auth)

### Clients (`/clients`)
- `GET /clients` - Get client list
- `GET /clients/me/assignments` - Get user's assigned clients (requires auth)

### Admin (`/admin`) - All require admin role
- `GET /admin/users` - List all users
- `GET /admin/clients` - List all clients
- `GET /admin/clients/:id` - Get client details
- `PUT /admin/clients/:id` - Update client
- `GET /admin/messages` - List all messages
- `GET /admin/messages/:id` - Get message details
- `PUT /admin/messages/:id` - Update message
- `GET /admin/assignments` - Get user assignments
- `PUT /admin/assignments` - Set user assignments
- `GET /admin/activities` - Get activity logs

### Activities (`/activities`)
- `POST /activities` - Record activity (requires auth)
- `GET /activities` - Get user's activities (requires auth)

### Health & Push
- `GET /health` - Health check
- `GET /push/vapid-public-key` - Get VAPID public key

## Middleware

### Authentication Middleware
- `authenticate` - Requires valid auth token
- `requireAdmin` - Requires admin role
- `optionalAuth` - Attaches user if token provided

### Logging Middleware
- Logs all HTTP requests
- Color-coded status codes
- Response time tracking
- Client IP detection
- Optional file logging

## Database Connection

Mongoose manages:
- Connection pooling (max 10 connections)
- Automatic reconnection
- Connection timeout (10 seconds)
- Server selection timeout (5 seconds)

## Error Handling

1. **Validation Errors** (400)
   - Missing required fields
   - Invalid data

2. **Authentication Errors** (401)
   - Missing token
   - Expired token
   - Invalid token

3. **Authorization Errors** (403)
   - Insufficient permissions
   - Admin role required

4. **Not Found Errors** (404)
   - Resource not found

5. **Server Errors** (500)
   - Database errors
   - Unexpected exceptions

## WebSocket

WebSocket connections are handled by the legacy `MessageServer` class:
- Attached via `attachWebSocketServer()` in `src/app.js`
- Uses same HTTP server as Express
- Separate connection handling

## Configuration

Environment variables:
```
MONGO_URL=mongodb://localhost:27017/fiverr-agent
MONGO_DB_NAME=fiverr-agent
PORT=8765
RENDER=false
HTTP_LOG_FILE=false
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

## Running the Server

```bash
# Install dependencies
npm install

# Start server
npm start

# Development with auto-reload
npm run dev
```

## Migration Path

The server is structured to:
1. Use Express + Mongoose for REST API
2. Keep legacy MessageServer for WebSocket (backward compatible)
3. Gradually migrate WebSocket logic to Express-WS or similar
4. All REST endpoints are Express-based

## Benefits of This Structure

✅ **Separation of Concerns** - Models, Controllers, Routes clearly separated
✅ **Scalability** - Easy to add new endpoints
✅ **Testing** - Each component can be tested independently
✅ **Maintainability** - Clear organization and flow
✅ **Type Safety** - Mongoose schemas provide validation
✅ **Logging** - Built-in HTTP request logging
✅ **Security** - Authentication middleware for protected routes
✅ **Performance** - Indexed MongoDB queries, connection pooling
