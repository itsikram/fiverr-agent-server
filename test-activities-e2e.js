#!/usr/bin/env node
/**
 * End-to-End Test for Activity Tracking System
 *
 * This script tests:
 * 1. MongoDB connection and collection existence
 * 2. POST /activities endpoint with sample activity data
 * 3. GET /admin/activities endpoint to retrieve activities
 * 4. Data persistence and retrieval validation
 *
 * Usage:
 *   node test-activities-e2e.js [--port 8765]
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import http from "http";

// Load environment
dotenv.config();

const DEFAULT_PORT = 8765;
const DEFAULT_MONGO_URI =
  "mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent?appName=Cluster0";

const MONGO_URI = (
  process.env.MONGODB_URI ||
  process.env.MONGODB_URL ||
  process.env.mongodb_url ||
  DEFAULT_MONGO_URI
).trim();

// Parse command line args
const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith("--port"));
const PORT = portArg ? parseInt(portArg.split("=")[1] || DEFAULT_PORT) : DEFAULT_PORT;

// Color codes for output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let prefix = "";

  switch (level) {
    case "info":
      prefix = `${colors.blue}[INFO]${colors.reset}`;
      break;
    case "success":
      prefix = `${colors.green}[✓]${colors.reset}`;
      break;
    case "error":
      prefix = `${colors.red}[✗]${colors.reset}`;
      break;
    case "warn":
      prefix = `${colors.yellow}[!]${colors.reset}`;
      break;
    case "section":
      prefix = `${colors.cyan}[${colors.bright}${message}${colors.reset}${colors.cyan}]${colors.reset}`;
      console.log(`\n${prefix}`);
      return;
    default:
      prefix = "[LOG]";
  }

  console.log(`${prefix} ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function makePrettified(obj) {
  return JSON.stringify(obj, null, 2);
}

// HTTP request helper
async function httpRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        } catch {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
          });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Test steps
async function testMongoConnection() {
  log("section", "STEP 1: Testing MongoDB Connection");

  try {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    log("success", "Connected to MongoDB");

    const db = client.db("fiverr_agent");
    const collections = await db.listCollections().toArray();
    const hasActivityCollection = collections.some(
      (c) => c.name === "user_activities"
    );

    if (hasActivityCollection) {
      log("success", "user_activities collection exists");
    } else {
      log("warn", "user_activities collection not found (will be created on first insert)");
    }

    // Check collection details if it exists
    if (hasActivityCollection) {
      const coll = db.collection("user_activities");
      const indexInfo = await coll.getIndexes();
      log("info", `Indexes on user_activities collection:`, indexInfo);

      const count = await coll.countDocuments();
      log("info", `Current documents in collection: ${count}`);
    }

    await client.close();
    return true;
  } catch (error) {
    log("error", `MongoDB connection failed: ${error.message}`);
    log("error", `URI used (with password masked): ${MONGO_URI.replace(/:([^:@]+)@/, ":****@")}`);
    return false;
  }
}

async function testServerHealth() {
  log("section", "STEP 2: Testing Server Health");

  try {
    const result = await httpRequest("GET", "/health");
    if (result.status === 200) {
      log("success", "Server is running and healthy");
      log("info", "Health check response:", result.body);
      return true;
    } else {
      log(
        "error",
        `Server returned status ${result.status} instead of 200`
      );
      return false;
    }
  } catch (error) {
    log(
      "error",
      `Server health check failed: ${error.message}. Is the server running on port ${PORT}?`
    );
    return false;
  }
}

async function testCreateTestUser() {
  log("section", "STEP 3: Creating Test User");

  try {
    const testUser = {
      username: `test_user_${Date.now()}`,
      email: `testuser_${Date.now()}@test.com`,
      password: "TestPassword123",
    };

    log("info", `Registering test user:`, testUser);

    const result = await httpRequest("POST", "/auth/register", testUser);

    if (result.status === 200 || result.status === 201) {
      log("success", "Test user created successfully");
      log("info", "Registration response:", result.body);
      return {
        user: testUser,
        token: result.body.token,
        success: true,
      };
    } else {
      log("error", `Registration failed with status ${result.status}`);
      log("info", "Response:", result.body);

      // Try to login if user already exists
      log("info", "Attempting to login with existing user...");
      const loginResult = await httpRequest("POST", "/auth/login", {
        email: testUser.email,
        password: testUser.password,
      });

      if (loginResult.status === 200) {
        log("success", "Logged in with existing test user");
        return {
          user: testUser,
          token: loginResult.body.token,
          success: true,
        };
      }

      return { success: false };
    }
  } catch (error) {
    log("error", `Failed to create/login test user: ${error.message}`);
    return { success: false };
  }
}

async function testPostActivity(authToken, userId) {
  log("section", "STEP 4: Testing POST /activities");

  try {
    const activityData = {
      userId: userId,
      category: "message",
      action: "send_message",
      detail: "Sent a test message to client",
      metadata: {
        conversationId: "conv_123",
        clientUsername: "test_client",
        messageLength: 150,
      },
    };

    log("info", `Posting activity data:`, activityData);

    const result = await httpRequest("POST", "/activities", activityData, {
      Authorization: `Bearer ${authToken}`,
    });

    if (result.status === 200 || result.status === 201) {
      log("success", "Activity posted successfully");
      log("info", "Response:", result.body);
      return {
        success: true,
        activityId: result.body._id,
        activity: activityData,
      };
    } else {
      log(
        "error",
        `POST /activities failed with status ${result.status}. Endpoint may not be implemented.`
      );
      log("info", "Response:", result.body);
      return { success: false };
    }
  } catch (error) {
    log("error", `Failed to post activity: ${error.message}`);
    return { success: false };
  }
}

async function testGetActivities(authToken, userId) {
  log("section", "STEP 5: Testing GET /admin/activities");

  try {
    const queryParams = new URLSearchParams({
      limit: "10",
      userId: userId,
    }).toString();

    const path = `/admin/activities${queryParams ? `?${queryParams}` : ""}`;
    log("info", `Fetching activities from: ${path}`);

    const result = await httpRequest("GET", path, null, {
      Authorization: `Bearer ${authToken}`,
    });

    if (result.status === 200) {
      log("success", "Retrieved activities successfully");
      const activities = result.body.activities || result.body;
      log(
        "info",
        `Found ${Array.isArray(activities) ? activities.length : "unknown"} activities`,
        activities
      );
      return {
        success: true,
        activities: activities,
      };
    } else if (result.status === 404) {
      log(
        "error",
        `GET /admin/activities endpoint not found (404). Endpoint may not be implemented.`
      );
      log("info", "Response:", result.body);
      return { success: false };
    } else {
      log(
        "error",
        `GET /admin/activities failed with status ${result.status}`
      );
      log("info", "Response:", result.body);
      return { success: false };
    }
  } catch (error) {
    log("error", `Failed to get activities: ${error.message}`);
    return { success: false };
  }
}

async function testValidateData(userId) {
  log("section", "STEP 6: Validating Data in MongoDB");

  try {
    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();

    const db = client.db("fiverr_agent");
    const coll = db.collection("user_activities");

    // Query for our test user's activities
    const activities = await coll
      .find({
        $or: [
          { userId: userId },
          { email: new RegExp(`test`, "i") },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    if (activities.length > 0) {
      log(
        "success",
        `Found ${activities.length} activity record(s) in MongoDB for test user`
      );
      log("info", "Activities in database:", activities);
      await client.close();
      return true;
    } else {
      log("warn", "No activities found in MongoDB for test user");
      log(
        "info",
        "This could mean: (1) The POST endpoint doesn't persist to DB, or (2) There's a slight delay"
      );
      await client.close();
      return false;
    }
  } catch (error) {
    log("error", `Failed to validate data in MongoDB: ${error.message}`);
    return false;
  }
}

// Main test runner
async function runTests() {
  console.log(`
${colors.bright}╔════════════════════════════════════════════════════════════╗
║   Activity Tracking System - End-to-End Test Suite            ║
║   ${new Date().toISOString()}                     ║
╚════════════════════════════════════════════════════════════════╝${colors.reset}
`);

  log("info", `MongoDB URI: ${MONGO_URI.replace(/:([^:@]+)@/, ":****@")}`);
  log("info", `Server Port: ${PORT}`);
  log("info", `Base URL: http://127.0.0.1:${PORT}`);

  const results = {
    mongoConnection: false,
    serverHealth: false,
    userCreation: false,
    postActivity: false,
    getActivities: false,
    dataValidation: false,
  };

  // Test MongoDB connection
  results.mongoConnection = await testMongoConnection();

  // Test server health
  results.serverHealth = await testServerHealth();

  if (!results.serverHealth) {
    log("error", "Server is not running. Start it with: npm start");
    printResults(results);
    process.exit(1);
  }

  // Create test user
  const userResult = await testCreateTestUser();

  if (!userResult.success) {
    log("error", "Could not create or authenticate test user");
    printResults(results);
    process.exit(1);
  }

  results.userCreation = true;

  // Post activity
  const postResult = await testPostActivity(userResult.token, userResult.user.email);
  results.postActivity = postResult.success;

  // Get activities
  const getResult = await testGetActivities(userResult.token, userResult.user.email);
  results.getActivities = getResult.success;

  // Validate data
  if (postResult.success) {
    // Wait a moment for data to be persisted
    await new Promise((resolve) => setTimeout(resolve, 1000));
    results.dataValidation = await testValidateData(userResult.user.email);
  }

  // Print summary
  printResults(results);

  // Exit with appropriate code
  const allPassed = Object.values(results).every((r) => r === true);
  process.exit(allPassed ? 0 : 1);
}

function printResults(results) {
  log("section", "TEST SUMMARY");

  console.log(`
${colors.bright}Test Results:${colors.reset}
${results.mongoConnection ? colors.green : colors.red}  ✓ MongoDB Connection${colors.reset}
${results.serverHealth ? colors.green : colors.red}  ✓ Server Health${colors.reset}
${results.userCreation ? colors.green : colors.red}  ✓ User Creation/Login${colors.reset}
${results.postActivity ? colors.green : colors.red}  ✓ POST /activities${colors.reset}
${results.getActivities ? colors.green : colors.red}  ✓ GET /admin/activities${colors.reset}
${results.dataValidation ? colors.green : colors.red}  ✓ Data Validation${colors.reset}
`);

  const passed = Object.values(results).filter((r) => r === true).length;
  const total = Object.values(results).length;

  console.log(
    `${colors.bright}Overall: ${passed}/${total} tests passed${colors.reset}\n`
  );

  if (!results.postActivity || !results.getActivities) {
    console.log(`${colors.yellow}Note:${colors.reset} The /activities and /admin/activities endpoints may not be implemented yet.`);
    console.log(`You may need to add them to MessageServer.js\n`);
  }
}

// Run tests
runTests().catch((error) => {
  log("error", `Unexpected error: ${error.message}`);
  process.exit(1);
});
