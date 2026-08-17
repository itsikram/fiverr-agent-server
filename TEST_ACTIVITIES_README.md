# Activity Tracking System - End-to-End Test Guide

This document explains how to run the end-to-end test for the activity tracking system.

## Overview

The test script (`test-activities-e2e.js`) validates the complete activity tracking workflow:

1. **MongoDB Connection** - Verifies database connectivity and collection existence
2. **Server Health** - Checks if the server is running and responsive
3. **User Management** - Creates/authenticates a test user
4. **Activity Logging** - POSTs activity data to `/activities` endpoint
5. **Activity Retrieval** - GETs activities from `/admin/activities` endpoint
6. **Data Validation** - Verifies data is actually stored in MongoDB

## Prerequisites

### 1. Ensure MongoDB is Running

The server needs access to MongoDB. Check your `.env` file in the `fiverr-server` directory:

```bash
# .env file should contain (or will use default):
MONGODB_URI=mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent?appName=Cluster0
```

**To verify MongoDB is accessible:**
```bash
mongosh "mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent"
```

### 2. Ensure the Server is Running

Start the message server in one terminal:

```bash
cd E:\fiverr-server
npm install  # if dependencies aren't installed
npm start
```

You should see output like:
```
[INFO] Server running on http://127.0.0.1:8765
```

## Running the Test

### Basic Usage

In a **separate terminal**, run:

```bash
cd E:\fiverr-server
node test-activities-e2e.js
```

### Custom Port

If your server is running on a different port:

```bash
node test-activities-e2e.js --port 9000
```

## Expected Output

### Successful Test Run

```
╔════════════════════════════════════════════════════════════╗
║   Activity Tracking System - End-to-End Test Suite         ║
╚════════════════════════════════════════════════════════════╝

[INFO] MongoDB URI: mongodb+srv://...:****@...
[INFO] Server Port: 8765
[INFO] Base URL: http://127.0.0.1:8765

[STEP 1: Testing MongoDB Connection]
[✓] Connected to MongoDB
[✓] user_activities collection exists
...

[STEP 2: Testing Server Health]
[✓] Server is running and healthy
...

[STEP 3: Creating Test User]
[✓] Test user created successfully
...

[STEP 4: Testing POST /activities]
[✓] Activity posted successfully
Response: {...}

[STEP 5: Testing GET /admin/activities]
[✓] Retrieved activities successfully
Found 5 activities
...

[STEP 6: Validating Data in MongoDB]
[✓] Found 1 activity record(s) in MongoDB for test user
Activities in database: [...]

Test Results:
  ✓ MongoDB Connection
  ✓ Server Health
  ✓ User Creation/Login
  ✓ POST /activities
  ✓ GET /admin/activities
  ✓ Data Validation

Overall: 6/6 tests passed
```

## Troubleshooting

### Issue: MongoDB Connection Failed

**Error:**
```
[✗] MongoDB connection failed: Error: connect ECONNREFUSED
```

**Solutions:**
1. Check if MongoDB Atlas is accessible from your network
2. Verify `MONGODB_URI` in `.env` is correct
3. Check your firewall/VPN settings
4. Try using a local MongoDB instance instead

### Issue: Server is Not Running

**Error:**
```
[✗] Server health check failed: Error: connect ECONNREFUSED. 
Is the server running on port 8765?
```

**Solutions:**
1. Start the server: `npm start` in the fiverr-server directory
2. Verify the port: `netstat -an | findstr :8765`
3. Check for conflicting processes

### Issue: Server Returns 404 for /activities Endpoints

**Error:**
```
[✗] GET /admin/activities endpoint not found (404). 
Endpoint may not be implemented.
```

**Explanation:** The endpoints need to be implemented in `MessageServer.js`

**Next Steps:**
The test will show which endpoints are missing. You'll need to implement:

1. **POST /activities** - Log user activities
   - Accept activity data (category, action, detail, metadata)
   - Store in MongoDB `user_activities` collection
   - Return 201 Created with the created activity

2. **GET /admin/activities** - Retrieve logged activities (admin only)
   - Require admin authentication
   - Support query filters (userId, category, action, from, to)
   - Return activity records from MongoDB

See [Implementation Guide](#implementation-guide) below.

### Issue: Activities Posted but Not Retrieved

**Diagnosis:**
- POST succeeds (status 200/201)
- GET succeeds but returns empty/wrong data
- MongoDB validation shows no records

**Possible Causes:**
1. POST endpoint doesn't call `activityTracker.logActivity()`
2. GET endpoint doesn't query the correct collection
3. MongoDB write concern issues
4. Wrong user/userId field matching

**To Debug:**
1. Check server logs during POST/GET requests
2. Manually query MongoDB:
   ```bash
   db.user_activities.find().sort({createdAt: -1}).limit(10)
   ```
3. Verify the activity data structure matches what's expected

## Implementation Guide

### Adding the Endpoints to MessageServer.js

The test expects these two endpoints. Here's the structure:

#### 1. POST /activities

```javascript
if (pathname === "/activities" && req.method === "POST") {
  (async () => {
    try {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader
        .toString()
        .replace(/^Bearer\s+/i, "")
        .trim();
      
      // Get authenticated user
      const user = await this.getUserByToken(token);
      if (!user) {
        await this.sendJsonResponse(res, 401, {
          error: "Unauthorized"
        });
        return;
      }

      // Parse activity data
      const body = await this.parseJsonBody(req);

      // Log the activity using activityTracker
      const activity = await this.activityTracker.logActivity({
        user,
        category: body.category,
        action: body.action,
        detail: body.detail,
        metadata: body.metadata,
        req
      });

      await this.sendJsonResponse(res, 201, activity);
    } catch (error) {
      await this.sendJsonResponse(res, 500, {
        error: "Internal server error"
      });
    }
  })();
  return;
}
```

#### 2. GET /admin/activities

```javascript
if (pathname === "/admin/activities" && req.method === "GET") {
  (async () => {
    try {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader
        .toString()
        .replace(/^Bearer\s+/i, "")
        .trim();
      
      // Require admin
      const user = await this.requireAdmin(token, req, res);
      if (!user) return;

      // Parse query parameters
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = url.searchParams.get("limit");
      const userId = url.searchParams.get("userId");
      const category = url.searchParams.get("category");
      const action = url.searchParams.get("action");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      // Fetch activities from tracker
      const activities = await this.activityTracker.listActivities({
        limit: limit ? parseInt(limit) : 200,
        userId,
        category,
        action,
        from,
        to
      });

      await this.sendJsonResponse(res, 200, {
        activities
      });
    } catch (error) {
      await this.sendJsonResponse(res, 500, {
        error: "Internal server error"
      });
    }
  })();
  return;
}
```

### Integration Steps

1. **Import ActivityTracker** at the top of MessageServer.js:
   ```javascript
   import { ActivityTracker } from './utils/activityTracker.js';
   ```

2. **Initialize in constructor**:
   ```javascript
   this.activityTracker = new ActivityTracker({
     isAdminFn: (user) => this.isAdminEmail(user.email),
     mongodbUrl: MONGO_URI
   });
   ```

3. **Connect MongoDB** when available:
   ```javascript
   // After MongoDB connection is established
   const db = await this.getMongoDb();
   if (db) {
     this.activityTracker.setMongoConnection({
       db,
       getCollection: async () => db.collection('user_activities')
     });
   }
   ```

4. **Add endpoints** to `createHttpServer()` method (before the 404 handler)

## Test Data Examples

### Activity POST Body
```json
{
  "userId": "user@example.com",
  "category": "message",
  "action": "send_message",
  "detail": "Sent a test message to client",
  "metadata": {
    "conversationId": "conv_123",
    "clientUsername": "test_client",
    "messageLength": 150
  }
}
```

### Activity GET Response
```json
{
  "activities": [
    {
      "_id": "1234567890_abc12345",
      "userId": "user@example.com",
      "username": "testuser",
      "email": "user@example.com",
      "role": "user",
      "category": "message",
      "action": "send_message",
      "detail": "Sent a test message to client",
      "metadata": {
        "conversationId": "conv_123",
        "clientUsername": "test_client",
        "messageLength": 150
      },
      "ip": "127.0.0.1",
      "userAgent": "...",
      "createdAt": "2024-01-15T10:30:45.123Z",
      "timestamp": 1705318245123
    }
  ]
}
```

## MongoDB Collection Schema

The test expects activities stored with this structure:

```javascript
{
  _id: String,                    // Unique identifier
  userId: String,                 // User ID or email
  username: String,               // Username (nullable)
  email: String,                  // User email
  role: String,                   // User role
  category: String,               // auth|message|client|navigation|settings|extraction|connection|push|system
  action: String,                 // Specific action name
  detail: String,                 // Human-readable description
  metadata: Object,               // Additional structured data
  ip: String,                     // Client IP address
  userAgent: String,              // Client user agent
  createdAt: String,              // ISO timestamp
  timestamp: Number               // Unix timestamp in milliseconds
}
```

## Diagnostic Checklist

When activities don't show up, verify:

- [ ] MongoDB is accessible from the server
- [ ] `user_activities` collection exists or will be auto-created
- [ ] POST endpoint calls `activityTracker.logActivity()`
- [ ] The user is not an admin (admins are not logged)
- [ ] Data is being written to MongoDB (not just local JSON)
- [ ] GET endpoint is querying the right user/filters
- [ ] Response includes all activity fields
- [ ] Admin authentication is working

## Performance Notes

- Activities are stored in MongoDB with a local JSON fallback
- The system keeps recent 2000+ activities in memory for quick access
- Queries support filtering by userId, category, action, and date range
- Default limit is 200 activities per request (max 1000)

## Next Steps

After the tests pass:

1. Review the test output for any warnings
2. Monitor MongoDB logs for write errors
3. Implement any missing endpoints identified by the test
4. Consider adding indexes on frequently queried fields
5. Set up retention policies for old activities
