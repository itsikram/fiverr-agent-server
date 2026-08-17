#!/usr/bin/env node
/**
 * Quick endpoint checker - Verifies if activity endpoints are implemented
 */

import http from "http";

const PORT = process.env.PORT || 8765;

const endpoints = [
  { method: "POST", path: "/activities", requiresAuth: true },
  { method: "GET", path: "/admin/activities", requiresAuth: true },
];

async function checkEndpoint(method, path) {
  return new Promise((resolve) => {
    const options = {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method,
      headers: {
        "Authorization": "Bearer test-token-for-checking",
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      // We're looking for NOT 404
      const isImplemented = res.statusCode !== 404;
      resolve({
        path,
        method,
        statusCode: res.statusCode,
        isImplemented,
      });
      res.destroy();
    });

    req.on("error", () => {
      resolve({
        path,
        method,
        statusCode: 0,
        isImplemented: false,
        error: "Connection failed",
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        path,
        method,
        statusCode: 0,
        isImplemented: false,
        error: "Timeout",
      });
    });

    req.end();
  });
}

async function main() {
  console.log("\n📋 Activity Tracking Endpoints - Status Check\n");
  console.log(`Checking server on http://127.0.0.1:${PORT}\n`);

  const results = await Promise.all(
    endpoints.map((ep) => checkEndpoint(ep.method, ep.path))
  );

  let allImplemented = true;

  for (const result of results) {
    const status = result.isImplemented ? "✓ IMPLEMENTED" : "✗ MISSING";
    const statusColor = result.isImplemented ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log(
      `${statusColor}${status}${reset} ${result.method.padEnd(6)} ${result.path.padEnd(30)} (${result.statusCode})`
    );

    if (!result.isImplemented) {
      allImplemented = false;
    }
  }

  console.log("\n");

  if (allImplemented) {
    console.log("✓ All required endpoints are implemented!\n");
    process.exit(0);
  } else {
    console.log(
      "✗ Some endpoints are missing. See TEST_ACTIVITIES_README.md for implementation guide.\n"
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
