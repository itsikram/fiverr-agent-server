import assert from "node:assert/strict";
import test from "node:test";
import { MessageServer } from "../MessageServer.js";
import {
  GIG_CATALOG_DOC_PREFIX,
  sanitizeGigCatalog,
} from "../src/utils/gigCatalog.js";

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

const setup = () => {
  const server = new MessageServer(0);
  server.broadcasts = [];
  server.broadcastToExpoClients = async (msg) => server.broadcasts.push(msg);
  server.getStore = async () => null;
  return server;
};

const register = (server, id, type, ws) => {
  ws._sessionId = id;
  server.connectedClients.set(id, ws);
  server.clientTypes.set(id, type);
};

const sampleCatalog = () => ({
  sellerUsername: "@ProgramerIkram",
  extractedAt: "2026-11-05T10:00:00.000Z",
  gigs: [
    {
      gigId: "414892690",
      slug: "create-wordpress-website-design",
      owner: "programerikram",
      url: "https://www.fiverr.com/programerikram/create-wordpress-website-design?ref=x",
      title: "I will create wordpress website design",
      currency: "USD",
      packages: [
        {
          tier: "Basic",
          name: "Basic",
          price: 50,
          deliveryDays: 3,
          revisions: "2",
          features: [{ name: "Number of pages", value: "1" }],
          extraFast: { price: 20, deliveryDays: 1 },
        },
      ],
      extras: [{ title: "Additional page", price: 25, deliveryDays: 1 }],
      faq: [{ question: "Hosting?", answer: "I can set it up." }],
    },
  ],
});

test("fetch_gigs reaches the extension with only clean gig URLs", async () => {
  const server = setup();
  const expo = fakeSocket();
  const browser = fakeSocket();
  register(server, "expo", "expo", expo);
  register(server, "browser", "browser", browser);

  await server.handleMessage(
    {
      type: "fetch_gigs",
      requestId: "r1",
      sellerUsername: "@ProgramerIkram",
      gigUrls: [
        "https://www.fiverr.com/programerikram/create-wordpress-website-design?x=1",
        "javascript:alert(1)",
        "https://evil.example/programerikram/a-b",
        "https://www.fiverr.com/inbox",
      ],
    },
    expo,
  );

  const command = browser.sent[0].commands[0];
  assert.equal(command.type, "fetch_gigs");
  assert.equal(command.requestId, "r1");
  assert.equal(command.sellerUsername, "programerikram");
  assert.deepEqual(command.gigUrls, [
    "https://www.fiverr.com/programerikram/create-wordpress-website-design",
  ]);
  assert.equal(expo.sent.at(-1).status, "success");
});

test("fetch_gigs without a connected extension answers with an error status", async () => {
  const server = setup();
  const expo = fakeSocket();
  register(server, "expo", "expo", expo);

  await server.handleMessage({ type: "fetch_gigs", requestId: "r2" }, expo);

  const status = expo.sent.find((msg) => msg.type === "gig_fetch_status");
  assert.equal(status.data.status, "error");
  assert.equal(status.data.requestId, "r2");
  assert.match(status.data.message, /not connected/);
  // Error acks are matched to client-detail requests, so this one must not be.
  assert.equal(expo.sent.find((msg) => msg.type === "ack").status, "success");
});

test("gig_data is validated, kept, persisted, and sent to the app", async () => {
  const server = setup();
  const saved = [];
  server.getStore = async () => ({
    sellerProfiles: {
      replace: async (id, doc) => saved.push({ id, doc }),
    },
  });
  const browser = fakeSocket();
  register(server, "browser", "browser", browser);

  const raw = sampleCatalog();
  raw.gigs.push(
    ...Array.from({ length: 40 }, (_, i) => ({
      slug: `extra-gig-number-${i}`,
      url: `https://www.fiverr.com/programerikram/extra-gig-number-${i}`,
      title: "x".repeat(5000),
      imageUrl: "javascript:alert(1)",
      packages: [{ name: "Basic", price: "not a number", deliveryDays: 9999 }],
    })),
  );
  await server.handleMessage({ type: "gig_data", data: { ...raw, requestId: "r3" } }, browser);

  const catalog = server.sellerGigCatalogs.get("programerikram");
  assert.ok(catalog, "catalog is stored under the lowercase username");
  assert.equal(catalog.gigs.length, 30, "gig count is capped");
  const [first] = catalog.gigs;
  assert.equal(first.url, "https://www.fiverr.com/programerikram/create-wordpress-website-design");
  assert.deepEqual(first.packages[0].extraFast, { price: 20, deliveryDays: 1 });
  assert.equal(catalog.gigs[1].title.length, 200, "titles are capped");
  assert.equal(catalog.gigs[1].imageUrl, null, "unsafe URLs are dropped");
  assert.equal(catalog.gigs[1].packages[0].price, null);
  assert.equal(catalog.gigs[1].packages[0].deliveryDays, null);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, `${GIG_CATALOG_DOC_PREFIX}programerikram`);
  assert.equal(saved[0].doc.catalog.sellerUsername, "programerikram");

  const broadcast = server.broadcasts.find((msg) => msg.type === "gig_catalog");
  assert.equal(broadcast.requestId, "r3");
  assert.equal(broadcast.data.gigs.length, 30);
});

test("the app cannot overwrite the gig catalog", async () => {
  const server = setup();
  const expo = fakeSocket();
  register(server, "expo", "expo", expo);

  await server.handleMessage({ type: "gig_data", data: sampleCatalog() }, expo);

  assert.equal(server.sellerGigCatalogs.size, 0);
  assert.equal(expo.sent.at(-1).status, "error");
});

test("gig_fetch_status progress reaches the app with clamped fields", async () => {
  const server = setup();
  const browser = fakeSocket();
  register(server, "browser", "browser", browser);

  await server.handleMessage(
    {
      type: "gig_fetch_status",
      requestId: "r4",
      status: "weird",
      message: "m".repeat(1000),
      current: 2,
      total: -5,
    },
    browser,
  );

  const status = server.broadcasts.find((msg) => msg.type === "gig_fetch_status");
  assert.equal(status.data.status, "progress");
  assert.equal(status.data.message.length, 300);
  assert.equal(status.data.current, 2);
  assert.equal(status.data.total, null);
});

test("stored catalogs load from the database without becoming seller profiles", async () => {
  const server = setup();
  const catalog = sanitizeGigCatalog(sampleCatalog());
  const docs = [
    { _id: "programerikram", username: "programerikram", profileName: "Md Ikram" },
    {
      _id: `${GIG_CATALOG_DOC_PREFIX}programerikram`,
      username: "programerikram",
      kind: "gig_catalog",
      catalog,
    },
  ];
  const profiles = await server.loadSellerProfilesFromDb({
    sellerProfiles: { list: async () => docs },
  });

  assert.deepEqual(Array.from(profiles.keys()), ["programerikram"]);
  assert.equal(server.sellerGigCatalogs.get("programerikram").gigs.length, 1);
});

test("a connecting app receives the stored gig catalogs", async () => {
  const server = setup();
  server.ensureClientListHydratedFromDb = async () => {};
  server.getAssignedClientIds = async () => [];
  server.loadMessagesFromDb = async () => [];
  server.filterMessagePayloadsForUser = async (_user, payloads) => payloads;
  const catalog = sanitizeGigCatalog(sampleCatalog());
  server.sellerGigCatalogs.set(catalog.sellerUsername, catalog);

  const expo = fakeSocket();
  await server.sendStoredDataToExpo(expo);
  const message = expo.sent.find((msg) => msg.type === "gig_catalogs");
  assert.equal(message.data[0].sellerUsername, "programerikram");

  const again = fakeSocket();
  register(server, "expo-2", "expo", again);
  await server.handleMessage({ type: "request_gig_catalogs" }, again);
  assert.equal(again.sent[0].data[0].gigs[0].title, "I will create wordpress website design");
});
