import assert from "node:assert/strict";
import test from "node:test";
import { MessageServer } from "../MessageServer.js";

const makeUser = (id) => ({
  _id: id,
  email: `${id}@example.com`,
  role: "user",
});

test("login falls back to local users when MongoDB is unavailable", async () => {
  const server = new MessageServer(0);
  server.mongodbUrl = "mongodb://example.invalid/test";
  server.localUsers = new Map([
    [
      "local-user@example.com",
      {
        username: "local-user",
        email: "local-user@example.com",
        passwordHash: "hash",
        passwordSalt: "salt",
        role: "user",
      },
    ],
  ]);
  server.getMongoUsersCollection = async () => null;

  const user = await server.getUserByEmail("local-user@example.com");

  assert.ok(user);
  assert.equal(user.email, "local-user@example.com");
});

test("non-admin users only receive assigned clients", async () => {
  const server = new MessageServer(0);
  const user = makeUser("user-1");
  const assignedIds = ["client-alpha", "client-beta"];
  const assignmentDocs = [];

  server.getMongoAssignmentsCollection = async () => ({
    async deleteMany(filter) {
      const next = [];
      for (const doc of assignmentDocs) {
        if (doc.userId !== filter.userId) {
          next.push(doc);
        }
      }
      assignmentDocs.splice(0, assignmentDocs.length, ...next);
    },
    async insertMany(docs) {
      assignmentDocs.push(...docs);
    },
    find(filter) {
      return {
        async toArray() {
          return assignmentDocs.filter((doc) => doc.userId === filter.userId);
        },
      };
    },
  });

  await server.setUserClientAssignments(user._id, assignedIds);

  const payload = {
    clients: [
      {
        username: "client-alpha",
        conversationId: "client-alpha",
        name: "Alpha",
      },
      { username: "client-beta", conversationId: "client-beta", name: "Beta" },
      {
        username: "client-gamma",
        conversationId: "client-gamma",
        name: "Gamma",
      },
    ],
  };

  const filtered = await server.filterClientListForUser(user, payload);
  const usernames = filtered.clients.map((client) => client.username);

  assert.deepEqual(usernames, ["client-alpha", "client-beta"]);
  assert.equal(await server.canUserAccessClient(user, "client-alpha"), true);
  assert.equal(await server.canUserAccessClient(user, "client-gamma"), false);
});

test("non-admin message refreshes are filtered by assigned clients and the selected target", async () => {
  const server = new MessageServer(0);
  const user = makeUser("user-2");
  const assignmentDocs = [];

  server.getMongoAssignmentsCollection = async () => ({
    async deleteMany(filter) {
      const next = [];
      for (const doc of assignmentDocs) {
        if (doc.userId !== filter.userId) {
          next.push(doc);
        }
      }
      assignmentDocs.splice(0, assignmentDocs.length, ...next);
    },
    async insertMany(docs) {
      assignmentDocs.push(...docs);
    },
    find(filter) {
      return {
        async toArray() {
          return assignmentDocs.filter((doc) => doc.userId === filter.userId);
        },
      };
    },
  });

  await server.setUserClientAssignments(user._id, ["client-alpha"]);

  const payloads = [
    {
      conversationId: "client-alpha",
      messages: [{ text: "hi" }],
      clients: [{ username: "client-alpha" }],
    },
    {
      conversationId: "client-gamma",
      messages: [{ text: "nope" }],
      clients: [{ username: "client-gamma" }],
    },
  ];

  const filtered = await server.filterMessagePayloadsForUser(
    user,
    payloads,
    "client-alpha",
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].conversationId, "client-alpha");
});
