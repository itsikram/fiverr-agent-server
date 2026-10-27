import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createApp } from "../src/app.js";
import { setStore } from "../src/config/database.js";
import {
  normalizeWebsiteUrl,
  sanitizePortfolioInput,
  sortPortfolioItems,
} from "../src/controllers/portfolioController.js";

const makeStore = () => {
  const users = [
    { _id: "u1", username: "alice", email: "a@example.com", role: "user", token: "t1" },
    { _id: "u2", username: "bob", email: "b@example.com", role: "user", token: "t2" },
  ];
  const docs = new Map();
  return {
    users: {
      async findByToken(token) {
        return users.find((user) => user.token === token) || null;
      },
      async findByUsername(username) {
        return users.find((user) => user.username === username) || null;
      },
    },
    portfolio: {
      async findById(id) {
        return docs.get(String(id)) || null;
      },
      async list({ where = {} } = {}) {
        return [...docs.values()].filter((doc) => !where.userId || doc.userId === where.userId);
      },
      async set(id, fields, { upsert = false } = {}) {
        const existing = docs.get(id);
        if (!existing && !upsert) return null;
        const now = new Date().toISOString();
        const doc = { ...(existing || { _id: id, created_at: now }), ...fields, updated_at: now };
        docs.set(id, doc);
        return doc;
      },
      async remove(id) {
        return docs.delete(String(id));
      },
    },
  };
};

const startApp = async () => {
  setStore(makeStore());
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    call,
    close: () => {
      setStore(null);
      return new Promise((resolve) => server.close(resolve));
    },
  };
};

test("website URLs are normalized and unsafe schemes rejected", () => {
  assert.equal(normalizeWebsiteUrl("example.com"), "https://example.com/");
  assert.equal(normalizeWebsiteUrl("http://shop.example.com/a"), "http://shop.example.com/a");
  assert.equal(normalizeWebsiteUrl("javascript:alert(1)"), "");
  assert.equal(normalizeWebsiteUrl("not a url"), "");
});

test("input is trimmed, skills deduped, unknown fields dropped", () => {
  const fields = sanitizePortfolioInput({
    title: "  Store redesign  ",
    skills: "React, react, Node ,",
    rating: 7,
    userId: "someone-else",
  });
  assert.equal(fields.title, "Store redesign");
  assert.deepEqual(fields.skills, ["React", "Node"]);
  assert.equal(fields.rating, 5);
  assert.equal("userId" in fields, false);
});

test("featured projects sort first, then newest completion", () => {
  const sorted = sortPortfolioItems([
    { _id: "a", completedAt: "2026-01-01" },
    { _id: "b", completedAt: "2026-05-01" },
    { _id: "c", completedAt: "2025-01-01", featured: true },
  ]);
  assert.deepEqual(sorted.map((item) => item._id), ["c", "b", "a"]);
});

test("portfolio CRUD is scoped to the signed-in user", async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call("GET", "/portfolio")).status, 401);

    const invalid = await app.call("POST", "/portfolio", { token: "t1", body: { title: "" } });
    assert.equal(invalid.status, 400);

    const created = await app.call("POST", "/portfolio", {
      token: "t1",
      body: { title: "Shopify store", websiteUrl: "shop.example.com", task: "Built theme" },
    });
    assert.equal(created.status, 201);
    const id = created.data.item._id;
    assert.equal(created.data.item.websiteUrl, "https://shop.example.com/");
    assert.equal(created.data.item.userId, "u1");

    const mine = await app.call("GET", "/portfolio", { token: "t1" });
    assert.equal(mine.data.items.length, 1);
    const theirs = await app.call("GET", "/portfolio", { token: "t2" });
    assert.equal(theirs.data.items.length, 0);

    assert.equal((await app.call("PUT", `/portfolio/${id}`, { token: "t2", body: { title: "x" } })).status, 404);
    assert.equal((await app.call("DELETE", `/portfolio/${id}`, { token: "t2" })).status, 404);

    const updated = await app.call("PUT", `/portfolio/${id}`, {
      token: "t1",
      body: { featured: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.item.featured, true);
    assert.equal(updated.data.item.title, "Shopify store");

    assert.equal((await app.call("DELETE", `/portfolio/${id}`, { token: "t1" })).status, 200);
    assert.equal((await app.call("GET", "/portfolio", { token: "t1" })).data.items.length, 0);
  } finally {
    await app.close();
  }
});

test("public portfolio shows only public projects and hides client identity", async () => {
  const app = await startApp();
  try {
    await app.call("POST", "/portfolio", {
      token: "t1",
      body: {
        title: "Public site",
        websiteUrl: "public.example.com",
        clientName: "Jane",
        clientUsername: "jane_buyer",
        isPublic: true,
      },
    });
    await app.call("POST", "/portfolio", {
      token: "t1",
      body: { title: "Private site", websiteUrl: "private.example.com" },
    });
    await app.call("POST", "/portfolio", {
      token: "t1",
      body: { title: "Named", task: "Logo", clientName: "Acme", isPublic: true, showClientName: true },
    });

    const result = await app.call("GET", "/portfolio/public/alice");
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.items.map((item) => item.title).sort(), ["Named", "Public site"]);
    const publicSite = result.data.items.find((item) => item.title === "Public site");
    assert.equal(publicSite.clientName, "");
    assert.equal("clientUsername" in publicSite, false);
    assert.equal("userId" in publicSite, false);
    assert.equal(result.data.items.find((item) => item.title === "Named").clientName, "Acme");

    assert.equal((await app.call("GET", "/portfolio/public/nobody")).status, 404);
  } finally {
    await app.close();
  }
});
