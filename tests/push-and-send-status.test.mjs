import assert from "node:assert/strict";
import test from "node:test";
import { MessageServer } from "../MessageServer.js";
import pushNotificationService from "../utils/pushNotificationService.js";

const users = {
  admin: { _id: "admin-1", email: "boss@example.com", role: "admin" },
  alice: { _id: "user-alice", email: "alice@example.com", role: "user" },
  bob: { _id: "user-bob", email: "bob@example.com", role: "user" },
};

// alice is assigned client "buyer1"; bob has no assignments.
const assignments = { "user-alice": ["buyer1"], "user-bob": [] };

const setup = () => {
  const server = new MessageServer(0);
  server.webPushHydrated = true;
  server.findUserForPush = async (id) =>
    Object.values(users).find((u) => u._id === String(id)) || null;
  server.getAssignedClientIds = async (user) =>
    assignments[server.getUserIdentifier(user)] || [];
  server.pushTokens.set("tok-admin", { token: "tok-admin", userId: "admin-1" });
  server.pushTokens.set("tok-alice", { token: "tok-alice", userId: "user-alice" });
  server.pushTokens.set("tok-bob", { token: "tok-bob", userId: "user-bob" });
  server.pushTokens.set("tok-anon", { token: "tok-anon", userId: null });
  return server;
};

const capturePushes = (t) => {
  const calls = [];
  t.mock.method(pushNotificationService, "sendToTargets", async (targets, payload) => {
    calls.push({ tokens: targets.map((x) => x.token).sort(), payload });
    return {};
  });
  return calls;
};

test("new-message push goes only to admins and users assigned to that client", async (t) => {
  const server = setup();
  const calls = capturePushes(t);

  await server.sendPushNotificationForMessage({
    conversationId: "buyer1",
    clientName: "Buyer One",
    messageText: "hello",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tokens, ["tok-admin", "tok-alice"]);

  await server.sendPushNotificationForMessage({
    conversationId: "stranger",
    messageText: "hi there",
  });
  assert.deepEqual(calls[1].tokens, ["tok-admin"]);
});

test("no push for messages the seller sent", async (t) => {
  const server = setup();
  const calls = capturePushes(t);

  await server.sendPushNotificationForMessage({
    conversationId: "buyer1",
    messageText: "my own reply",
    isFromMe: true,
  });
  assert.equal(calls.length, 0);
});

test("new-client push is limited the same way", async (t) => {
  const server = setup();
  const calls = capturePushes(t);

  await server.sendPushNotificationForNewClient({ username: "buyer1", name: "B" });
  assert.deepEqual(calls[0].tokens, ["tok-admin", "tok-alice"]);
});

test("send_message_status heartbeat keeps an in-flight send alive and reaches Expo", async () => {
  const server = new MessageServer(0);
  const broadcasts = [];
  server.broadcastToExpoClients = async (msg) => broadcasts.push(msg);
  const ws = { _sessionId: "b1", readyState: 1, send() {} };
  server.connectedClients.set("b1", ws);
  server.clientTypes.set("b1", "browser");

  const command = { clientMessageId: "m1", conversationId: "buyer1" };
  server.trackInFlightSend(command);
  const firstTimer = server.inFlightSends.get("m1").timeoutId;

  await server.handleMessage(
    { type: "send_message_status", data: { clientMessageId: "m1", status: "sending" } },
    ws,
  );

  const entry = server.inFlightSends.get("m1");
  assert.ok(entry, "send must still be tracked");
  assert.notEqual(entry.timeoutId, firstTimer, "timeout must be re-armed");
  assert.equal(broadcasts[0].type, "send_message_status");
  assert.equal(broadcasts[0].data.status, "sending");
  server.settleInFlightSend("m1");
});

test("messages sent right after connect wait for it (push token is not dropped)", async () => {
  const server = new MessageServer(0);
  server.getUserByToken = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return users.alice;
  };
  server.sendStoredDataToExpo = async () => {};
  server.sendPendingCommands = async () => {};
  server.broadcastExpoPresenceToBrowsers = () => {};

  const handlers = {};
  const ws = {
    readyState: 1,
    send() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  };
  server.handleWebSocketConnection(ws, {});

  const connect = handlers.message(
    JSON.stringify({ type: "connect", client_type: "expo", session_id: "e1", token: "t" }),
  );
  const register = handlers.message(
    JSON.stringify({ type: "register_push_token", pushToken: "tok-new" }),
  );
  await Promise.all([connect, register]);

  const record = server.pushTokens.get("tok-new");
  assert.ok(record, "push token must be registered");
  assert.equal(record.userId, "user-alice");
});

test("requests after connect are not held back by the stored-data dump", async () => {
  const server = new MessageServer(0);
  server.getUserByToken = async () => users.alice;
  let releaseDump;
  server.sendStoredDataToExpo = () =>
    new Promise((resolve) => {
      releaseDump = resolve;
    });
  server.broadcastExpoPresenceToBrowsers = () => {};
  server.ensureClientListHydratedFromDb = async () => {};
  server.filterClientListForUser = async (_user, list) => list;
  server.storedClientList = { clients: [{ username: "buyer1" }] };

  const sent = [];
  const handlers = {};
  const ws = {
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    on(event, fn) {
      handlers[event] = fn;
    },
  };
  server.handleWebSocketConnection(ws, {});

  const connect = handlers.message(
    JSON.stringify({ type: "connect", client_type: "expo", session_id: "e2", token: "t" }),
  );
  await handlers.message(JSON.stringify({ type: "request_client_list" }));

  assert.ok(
    sent.some((msg) => msg.type === "client_list_data"),
    "client list must be answered while the dump is still running",
  );
  releaseDump();
  await connect;
});
