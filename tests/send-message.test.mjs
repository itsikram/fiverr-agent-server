import assert from "node:assert/strict";
import test from "node:test";
import { MessageServer } from "../MessageServer.js";

const fakeSocket = (readyState = 1) => {
  const sent = [];
  return {
    readyState,
    sent,
    send(payload) {
      if (this.readyState !== 1) throw new Error("closed");
      sent.push(JSON.parse(payload));
    },
  };
};

const setup = () => {
  const server = new MessageServer(0);
  server.broadcasts = [];
  server.broadcastToExpoClients = async (msg) => server.broadcasts.push(msg);
  return server;
};

const register = (server, id, type, ws) => {
  ws._sessionId = id;
  server.connectedClients.set(id, ws);
  server.clientTypes.set(id, type);
};

test("send_message goes to exactly one live extension with its id", async () => {
  const server = setup();
  const expo = fakeSocket();
  const dead = fakeSocket(3);
  const live = fakeSocket();
  const other = fakeSocket();
  register(server, "expo", "expo", expo);
  register(server, "b-dead", "browser", dead);
  register(server, "b-live", "browser", live);
  register(server, "b-other", "browser", other);
  live._lastSeenAt = Date.now();
  other._lastSeenAt = Date.now() - 60000;

  await server.handleMessage(
    { type: "send_message", message: " hi ", conversationId: "alice", clientMessageId: "m1" },
    expo,
  );

  assert.equal(dead.sent.length, 0);
  assert.equal(other.sent.length, 0);
  assert.equal(live.sent.length, 1);
  const cmd = live.sent[0].commands.find((c) => c.type === "send_message");
  assert.equal(cmd.clientMessageId, "m1");
  assert.equal(cmd.message, "hi");
  assert.equal(cmd.conversationId, "alice");
  assert.equal(server.broadcasts[0].data.status, "forwarded");

  await server.handleMessage(
    { type: "send_message_result", data: { clientMessageId: "m1", success: true } },
    live,
  );
  assert.equal(server.inFlightSends.size, 0);
});

test("send_message is queued while offline and flushed when the extension connects", async () => {
  const server = setup();
  const expo = fakeSocket();
  register(server, "expo", "expo", expo);

  await server.handleMessage(
    { type: "send_message", message: "later", conversationId: "bob", clientMessageId: "m2" },
    expo,
  );
  assert.equal(server.pendingSendMessages.length, 1);
  assert.equal(server.broadcasts[0].data.status, "queued");

  const browser = fakeSocket();
  await server.handleMessage({ type: "connect", session_id: "b1", client_type: "browser" }, browser);
  const commands = browser.sent.filter((m) => m.type === "commands").flatMap((m) => m.commands);
  const send = commands.filter((c) => c.type === "send_message");
  assert.equal(send.length, 1);
  assert.equal(send[0].clientMessageId, "m2");
  assert.equal(server.pendingSendMessages.length, 0);
  for (const { timeoutId } of server.inFlightSends.values()) clearTimeout(timeoutId);
});

test("send_message without a target is rejected with a result", async () => {
  const server = setup();
  const expo = fakeSocket();
  register(server, "expo", "expo", expo);
  await server.handleMessage({ type: "send_message", message: "x", clientMessageId: "m3" }, expo);
  const result = expo.sent.find((m) => m.type === "send_message_result");
  assert.equal(result.data.success, false);
  assert.equal(result.data.clientMessageId, "m3");
});

test("a database error during a broadcast never rejects (would crash the process)", async () => {
  const server = new MessageServer(0);
  const expo = fakeSocket();
  register(server, "expo", "expo", expo);
  expo._user = { _id: "u1", email: "u1@example.com", role: "user" };
  server.getAssignedClientIds = async () => {
    throw new Error("MongoNetworkError: connection reset");
  };

  await assert.doesNotReject(() =>
    server.broadcastToExpoClients({ type: "client_list_data", data: { clients: [] } }),
  );
  // Delivery results are not client data, so they still reach the user.
  await server.broadcastToExpoClients({
    type: "send_message_result",
    data: { clientMessageId: "x", success: true },
  });
  assert.equal(expo.sent.filter((m) => m.type === "client_list_data").length, 0);
  assert.equal(expo.sent.filter((m) => m.type === "send_message_result").length, 1);
});
