# Activity Tracking System - Complete Testing Guide

## Overview

This guide covers everything you need to test the activity tracking system end-to-end, from initial setup through implementation and validation.

## Files Included

| File | Purpose |
|------|---------|
| `test-activities-e2e.js` | Main test script - runs all diagnostic tests |
| `check-endpoints.js` | Quick endpoint status checker |
| `QUICKSTART.md` | 3-step quick start guide |
| `TEST_ACTIVITIES_README.md` | Detailed testing & implementation guide |
| `TESTING_GUIDE.md` | This file - complete reference |

## Quick Start (2 minutes)

### Terminal 1: Start Server
```bash
cd E:\fiverr-server
npm start
```

### Terminal 2: Run Test
```bash
cd E:\fiverr-server
npm run test:activities
```

## Detailed Testing Flow

### Phase 1: Preparation

Before running tests, ensure:

1. **Node.js 18+** is installed
   ```bash
   node --version  # Should show v18.0.0 or higher
   ```

2. **Dependencies are installed**
   ```bash
   cd E:\fiverr-server
   npm install
   ```

3. **Environment is configured**
   - `.env` file should contain MongoDB URI (or use default)
   - Check: `cat .env | grep MONGODB`

4. **MongoDB is accessible**
   ```bash
   # Test connection
   mongosh "mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent"
   # Should connect successfully - type 'exit' to quit
   ```

### Phase 2: Start Server

In **Terminal 1**:
```bash
cd E:\fiverr-server
npm start
```

Expected output:
```
Server running on http://127.0.0.1:8765
```

Wait for server to be ready (you should see WebSocket and HTTP server messages).

### Phase 3: Check Endpoints (Optional)

Quick check to see which endpoints exist:
```bash
npm run check:endpoints
```

Output example:
```
✗ MISSING POST   /activities
✗ MISSING GET    /admin/activities
```

### Phase 4: Run Full Test Suite

In **Terminal 2**:
```bash
cd E:\fiverr-server
npm run test:activities
```

The test will run through 6 phases:

#### Phase 1: MongoDB Connection
- Attempts to connect to MongoDB
- Lists all collections
- Checks for `user_activities` collection
- Reports index information

**Success indicators:**
- ✓ Connected to MongoDB
- ✓ user_activities collection exists
- Lists indexes and document count

**Failure indicators:**
- ✗ MongoDB connection failed (check URI, network access)
- Collection doesn't exist (will be created on first insert)

#### Phase 2: Server Health
- Makes HTTP GET request to `/health` endpoint
- Verifies server responds with 200 status

**Success indicators:**
- ✓ Server is running and healthy
- Response includes WebSocket URL

**Failure indicators:**
- ✗ Server is not running (start with `npm start`)
- ✗ Port is in use (check `netstat -an | findstr :8765`)

#### Phase 3: User Creation/Authentication
- Creates a test user via `/auth/register` endpoint
- Falls back to login if user already
