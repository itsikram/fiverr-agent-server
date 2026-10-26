import assert from "node:assert/strict";
import test from "node:test";
import { MessageServer } from "../MessageServer.js";

const fakeSocket = () => {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
};

const register = (server, sessionId, type, ws) => {
  ws._sessionId = sessionId;
  ws._clientType = type;
  server.connectedClients.set(sessionId, ws);
  server.clientTypes.set(sessionId, type);
};

test("a reconnected app can fetch the outcome of its own sends", async () => {
  const server = new MessageServer(0);
  const extension = fakeSocket();
  const expo = fakeSocket();
  register(server, "ext", "browser", extension);
  register(server, "app", "expo", expo);

  await server.handleMessage(
    {
      type: "send_message_result",
      data: { clientMessageId: "cm-1", conversationId: "buyer1", success: true },
    },
    extension,
  );

  expo.sent.length = 0;
  await server.handleMessage(
    { type: "request_send_results", clientMessageIds: ["cm-1", "cm-unknown"] },
    expo,
  );

  assert.equal(expo.sent.length, 1);
  assert.equal(expo.sent[0].type, "send_message_result");
  assert.equal(expo.sent[0].data.clientMessageId, "cm-1");
  assert.equal(expo.sent[0].data.success, true);
});

test("reload details from the extension reach the app and are cached", async () => {
  const server = new MessageServer(0);
  const extension = fakeSocket();
  const expo = fakeSocket();
  register(server, "ext", "browser", extension);
  register(server, "app", "expo", expo);

  const history = [
    { timestamp: "2026-10-26T10:00:00Z", status: "success", url: "https://www.fiverr.com/users/me/manage_gigs", durationMs: 1200 },
  ];
  await server.handleMessage(
    {
      type: "reload_status_update",
      status: "armed",
      enabled: true,
      nextReloadAt: "2026-10-26T10:02:00Z",
      history,
    },
    extension,
  );

  const forwarded = expo.sent.find((m) => m.type === "reload_status_update");
  assert.ok(forwarded);
  assert.equal(forwarded.status, "armed");
  assert.deepEqual(forwarded.history, history);
  assert.equal(forwarded.lastReload.url, history[0].url);

  // A later status request is answered from the cache, not a hardcoded "idle".
  expo.sent.length = 0;
  await server.handleMessage({ type: "request_reload_status" }, expo);
  const response = expo.sent.find((m) => m.type === "reload_status_response");
  assert.equal(response.status, "armed");
  assert.equal(response.nextReloadAt, "2026-10-26T10:02:00Z");
});
