# Quick Start - Activity Tracking Test

## TL;DR - Run the Test in 3 Steps

### Step 1: Start the Server (Terminal 1)
```bash
cd E:\fiverr-server
npm install
npm start
```

Wait for: `Server running on http://127.0.0.1:8765`

### Step 2: Run the Test (Terminal 2)
```bash
cd E:\fiverr-server
node test-activities-e2e.js
```

### Step 3: Review Results

The test will show:
- ✓ or ✗ for each test phase
- Detailed diagnostic messages
- List of missing endpoints (if any)

## What Gets Tested

| Test | What It Does |
|------|-------------|
| MongoDB Connection | Checks if database is accessible |
| Server Health | Verifies server is running |
| User Creation | Creates a test user account |
| POST /activities | Sends activity data to server |
| GET /admin/activities | Retrieves activities back |
| Data Validation | Confirms data is in MongoDB |

## Common Issues & Fixes

### "Is the server running on port 8765?"
→ Run `npm start` in the fiverr-server directory

### "MongoDB connection failed"
→ Check `.env` file for `MONGODB_URI`

### "Endpoint not found (404)"
→ The `/activities` or `/admin/activities` endpoints aren't implemented yet. See TEST_ACTIVITIES_README.md for implementation guide.

## Custom Port

If server is on a different port:
```bash
node test-activities-e2e.js --port 9000
```

## Next: Implement Missing Endpoints

If the test shows 404 errors for `/activities` or `/admin/activities`:

1. Open `MessageServer.js`
2. Follow the implementation guide in `TEST_ACTIVITIES_README.md`
3. Add the two endpoint handlers
4. Re-run the test

## Useful Commands

Check server is listening:
```bash
# Windows
netstat -an | findstr :8765

# Or use this in Node:
node -e "const http = require('http'); http.get('http://127.0.0.1:8765/health', r => console.log(r.statusCode))"
```

Check MongoDB directly:
```bash
mongosh "mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent"

# In mongosh:
use fiverr_agent
db.user_activities.find().sort({createdAt: -1}).limit(5)
```

Kill process on port 8765:
```bash
# Windows (PowerShell)
$p = Get-Process | where {$_.Handles -ne $null} | Select-Object Id, Name, MainWindowTitle | where {$_.Id -eq (Get-NetTCPConnection | where {$_.LocalPort -eq 8765} | select -ExpandProperty OwningProcess)}
Stop-Process -Id $p.Id

# Or just restart with npm start
```

## Log Interpretation

### ✓ (Green Checkmark)
Test passed successfully

### ✗ (Red X)
Test failed - check the error message

### ! (Yellow Exclamation)
Warning - functionality might not work as expected but test continued

### [INFO]
General information about what's happening

### [STEP N: Title]
Starting a new test phase
