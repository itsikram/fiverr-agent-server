/**
 * Message Server for receiving Fiverr inbox data from browser extension via WebSocket
 */
import { WebSocketServer } from "ws";
import http from "http";
import { EventEmitter } from "events";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Resolver, promises as dnsPromises } from "dns";
import { fileURLToPath } from "url";
import { generateSessionId } from "./utils/serverUtils.js";
import pushNotificationService from "./utils/pushNotificationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MessageServer extends EventEmitter {
  constructor(port = null) {
    super();

    // Port configuration
    const isRender = process.env.RENDER === "true";
    const defaultPort = isRender ? 10000 : 8765;
    this.port =
      port !== null
        ? parseInt(port)
        : parseInt(process.env.PORT || defaultPort);

    // MongoDB configuration
    this.mongodbUrl = this.normalizeMongoUrl(
      (
        process.env.mongodb_url ||
        process.env.MONGODB_URL ||
        process.env.MONGODB_URI ||
        ""
      ).trim(),
    );
    const envDbName = (process.env.MONGODB_DB_NAME || "").trim();
    this.mongoDbName =
      envDbName ||
      this.parseMongoDbNameFromUrl(this.mongodbUrl) ||
      "fiverr_agent";
    this.mongoProfilesColl = (
      process.env.MONGODB_PROFILES_COLLECTION || "seller_profiles"
    ).trim();
    this.mongoClientsColl = (
      process.env.MONGODB_CLIENTS_COLLECTION || "clients"
    ).trim();
    this.mongoMessagesColl = (
      process.env.MONGODB_MESSAGES_COLLECTION || "messages"
    ).trim();
    this.mongoUsersColl = (
      process.env.MONGODB_USERS_COLLECTION || "users"
    ).trim();

    // Server state
    this.server = null;
    this.httpServer = null;
    this.wss = null;
    this.running = false;

    this.heartbeatIntervalId = null;

    // Client management
    this.connectedClients = new Map(); // session_id -> WebSocket
    this.clientSessions = new Map(); // WebSocket -> session_id
    this.clientTypes = new Map(); // session_id -> 'browser' | 'expo' | 'desktop'
    this.browserProfileBySession = new Map(); // session_id -> username

    // Pending commands
    this.pendingCommands = new Map(); // session_id -> [commands]
    this.pendingTrigger = false;
    this.pendingClientTrigger = false;
    this.pendingClientListTrigger = false;
    this.pendingSendMessage = null;
    this.pendingClickCommands = [];
    this.autoReplyConfig = null;
    this.tabReloadConfig = null;
    this.expoAppActivity = null;
    this.scheduledExtractionTimeouts = [];
    this.latestExtractionTarget = null;
    this.extractionGeneration = 0;

    // Data storage for Expo Go clients
    this.storedMessageData = null; // latest payload (legacy)
    this.storedMessageDataByConversation = new Map(); // conversationId -> payload
    this.scheduledExtractionByTarget = new Map(); // target -> timeout ids
    this.extractionGenerationByTarget = new Map(); // target -> generation
    this.storedClientData = new Map(); // key -> data
    this.storedClientList = null;
    this.storedNewMessages = [];
    this.storedClientActivations = [];

    // Push notification tokens (pushToken -> metadata). Kept after WebSocket
    // disconnect so native apps still receive alerts when closed.
    this.pushTokens = new Map(); // pushToken -> { token, userId, sessionId, registeredAt }
    this.sessionPushTokens = new Map(); // sessionId -> pushToken
    // Web Push subscriptions for Expo web / PWA (endpoint -> metadata)
    this.webPushSubscriptions = new Map();
    this.mongoPushSubscriptionsCollection = null;
    this.webPushHydrated = false;

    // Dedupe new-client alerts (username -> last notified timestamp)
    this.recentNewClientAlerts = new Map();
    // Dedupe unread/message push alerts (key -> last notified timestamp)
    this.recentMessagePushAlerts = new Map();

    // Seller profiles (persisted in MongoDB)
    this.sellerProfiles = new Map(); // username -> profile
    this.sellerProfile = null; // current (most recently received)

    // Local fallback user storage when MongoDB is unavailable
    this.localUsers = new Map();
    this.localAuthTokens = new Map();
    this.localUsersFilePath = path.join(__dirname, "data", "users.json");
    this.ensureLocalUsersStore();

    // MongoDB
    this.mongoClient = null;
    this.mongooseConnection = null;
    this.mongoConnectionPromise = null;
    this.mongoConnectionDisabled = false;
    this.mongoConnectionWarningShown = false;
    this.mongoProfilesCollection = null;
    this.mongoUsersCollection = null;
    this.mongoClientsCollection = null;
    this.mongoMessagesCollection = null;
    this.mongoAssignmentsCollection = null;
    this.mongoDb = null;

    // Lock for thread-safe operations
    this.lock = new Map(); // Simple lock using a flag

    // Load seller profiles
    this.loadSellerProfiles();
  }

  parseMongoDbNameFromUrl(url) {
    if (!url || typeof url !== "string") {
      return null;
    }

    const match = url.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?\/]+)(?:\?|$)/i);
    if (!match || !match[1]) {
      return null;
    }

    const dbName = match[1].trim().replace(/\/$/, "");
    return dbName ? decodeURIComponent(dbName) : null;
  }

  normalizeMongoUrl(url) {
    if (!url || typeof url !== "string") {
      return "";
    }

    let normalized = url.trim();
    if (!normalized) {
      return "";
    }

    const hasTlsFlag = /(?:^|[?&])(tls|ssl)=/i.test(normalized);
    const isAtlasLike =
      normalized.startsWith("mongodb+srv://") ||
      /mongodb(?:\.net|\.com)/i.test(normalized) ||
      /atlas/i.test(normalized);

    if (isAtlasLike && !hasTlsFlag) {
      const separator = normalized.includes("?") ? "&" : "?";
      normalized = `${normalized}${separator}tls=true`;
    }

    return normalized;
  }

  async isSrvFallbackError(error) {
    return (
      error?.code === "ECONNREFUSED" && /querySrv/i.test(error?.message || "")
    );
  }

  async createFallbackUriFromSrv(uri) {
    const url = new URL(uri);
    const resolver = new Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);

    const searchParams = new URLSearchParams(url.searchParams);
    if (!searchParams.has("tls") && !searchParams.has("ssl")) {
      searchParams.set("tls", "true");
    }
    if (!searchParams.has("retryWrites")) {
      searchParams.set("retryWrites", "true");
    }
    if (!searchParams.has("authSource")) {
      searchParams.set("authSource", "admin");
    }

    const auth = url.username
      ? `${encodeURIComponent(url.username)}${
          url.password ? `:${encodeURIComponent(url.password)}` : ""
        }@`
      : "";

    const srvRecords = await new Promise((resolve, reject) => {
      resolver.resolveSrv(`_mongodb._tcp.${url.hostname}`, (err, records) => {
        if (err) {
          reject(err);
        } else {
          resolve(records);
        }
      });
    });

    const hosts = srvRecords.map((record) => `${record.name}:${record.port}`);
    const dbName = url.pathname?.slice(1) || "";
    const searchString = searchParams.toString();

    return `mongodb://${auth}${hosts.join(",")}/${dbName}${
      searchString ? `?${searchString}` : ""
    }`;
  }

  getMongoClientOptions() {
    const isAtlasLike =
      this.mongodbUrl.startsWith("mongodb+srv://") ||
      /mongodb(?:\.net|\.com)/i.test(this.mongodbUrl) ||
      /atlas/i.test(this.mongodbUrl);

    return {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 20000,
      retryWrites: true,
      maxPoolSize: 5,
      appName: "fiverr-agent-server",
      dbName: this.mongoDbName,
      tls: isAtlasLike,
    };
  }

  async connectMongo() {
    if (!this.mongodbUrl) {
      if (!this.mongoConnectionWarningShown) {
        this.mongoConnectionWarningShown = true;
      }
      return null;
    }

    if (this.mongoConnectionDisabled) {
      return null;
    }

    if (this.mongooseConnection?.readyState === 1) {
      this.mongoClient = this.mongooseConnection;
      this.mongoDb = this.mongooseConnection.db;
      return this.mongooseConnection;
    }

    if (this.mongoConnectionPromise) {
      return this.mongoConnectionPromise;
    }

    const mongoOptions = this.getMongoClientOptions();
    this.mongoConnectionPromise = (async () => {
      await mongoose.connect(this.mongodbUrl, mongoOptions);

      this.mongooseConnection = mongoose.connection;
      this.mongoClient = this.mongooseConnection;
      this.mongoDb = this.mongooseConnection.db;

      this.mongooseConnection.on("error", (error) => {});

      this.mongooseConnection.on("disconnected", () => {});

      this.mongooseConnection.on("connected", () => {});

      return this.mongooseConnection;
    })().catch(async (error) => {
      const details = error?.cause?.code || error?.code || "unknown";
      if (
        this.mongodbUrl?.startsWith("mongodb+srv://") &&
        (await this.isSrvFallbackError(error))
      ) {
        try {
          const fallbackUri = await this.createFallbackUriFromSrv(
            this.mongodbUrl,
          );
          const safeFallbackUri = fallbackUri.replace(
            /(mongodb:\/\/)([^:]+):([^@]+)@/,
            "$1$2:*****@",
          );

          await mongoose.connect(fallbackUri, mongoOptions);

          this.mongooseConnection = mongoose.connection;
          this.mongoClient = this.mongooseConnection;
          this.mongoDb = this.mongooseConnection.db;

          return this.mongooseConnection;
        } catch (fallbackError) {
          const fallbackDetails =
            fallbackError?.cause?.code || fallbackError?.code || "unknown";
        }
      }

      if (!this.mongoConnectionWarningShown) {
        this.mongoConnectionWarningShown = true;
      }
      this.mongoConnectionDisabled = true;
      this.mongoClient = null;
      this.mongooseConnection = null;
      this.mongoDb = null;
      this.mongoProfilesCollection = null;
      this.mongoUsersCollection = null;
      this.mongoClientsCollection = null;
      this.mongoMessagesCollection = null;
      this.mongoAssignmentsCollection = null;
      this.mongoConnectionPromise = null;
      return null;
    });

    return this.mongoConnectionPromise;
  }

  /**
   * Get MongoDB profiles collection (lazy initialization)
   */
  async getMongoProfilesCollection() {
    if (!this.mongodbUrl) {
      return null;
    }

    if (this.mongoProfilesCollection) {
      return this.mongoProfilesCollection;
    }

    try {
      await this.connectMongo();
      if (!this.mongoDb) {
        return null;
      }

      this.mongoProfilesCollection = this.mongoDb.collection(
        this.mongoProfilesColl,
      );

      return this.mongoProfilesCollection;
    } catch (error) {
      const details = error?.cause?.code || error?.code || "unknown";

      this.mongoClient = null;
      this.mongooseConnection = null;
      this.mongoDb = null;
      this.mongoProfilesCollection = null;
      this.mongoUsersCollection = null;
      this.mongoClientsCollection = null;
      this.mongoMessagesCollection = null;
      this.mongoAssignmentsCollection = null;
      return null;
    }
  }

  /**
   * Get MongoDB database
   */
  async getMongoDb() {
    if (!this.mongodbUrl) {
      return null;
    }

    try {
      await this.connectMongo();
      return this.mongoDb;
    } catch (error) {
      return null;
    }
  }

  async getMongoClientsCollection() {
    if (!this.mongodbUrl) {
      return null;
    }

    if (this.mongoClientsCollection) {
      return this.mongoClientsCollection;
    }

    const db = await this.getMongoDb();
    if (!db) {
      return null;
    }

    this.mongoClientsCollection = db.collection(this.mongoClientsColl);
    return this.mongoClientsCollection;
  }

  async getMongoMessagesCollection() {
    if (!this.mongodbUrl) {
      return null;
    }

    if (this.mongoMessagesCollection) {
      return this.mongoMessagesCollection;
    }

    const db = await this.getMongoDb();
    if (!db) {
      return null;
    }

    this.mongoMessagesCollection = db.collection(this.mongoMessagesColl);
    return this.mongoMessagesCollection;
  }

  async getMongoAssignmentsCollection() {
    if (!this.mongodbUrl) {
      return null;
    }

    if (this.mongoAssignmentsCollection) {
      return this.mongoAssignmentsCollection;
    }

    const db = await this.getMongoDb();
    if (!db) {
      return null;
    }

    this.mongoAssignmentsCollection = db.collection("user_client_assignments");
    return this.mongoAssignmentsCollection;
  }

  async getMongoUsersCollection() {
    if (!this.mongodbUrl) {
      return null;
    }

    if (this.mongoUsersCollection) {
      return this.mongoUsersCollection;
    }

    const db = await this.getMongoDb();
    if (!db) {
      return null;
    }

    this.mongoUsersCollection = db.collection(this.mongoUsersColl);
    return this.mongoUsersCollection;
  }

  async getMongoUsersCollectionOrThrow() {
    return this.getMongoUsersCollection();
  }

  isAdminEmail(email) {
    return (
      (email || "").toString().trim().toLowerCase() === "mdikram295@gmail.com"
    );
  }

  normalizeRole(role, user = null) {
    const normalized = (role || "").toString().toLowerCase().trim();
    const email = (user?.email || "").toString().trim().toLowerCase();
    if (
      normalized === "admin" ||
      normalized === "administrator" ||
      this.isAdminEmail(email)
    ) {
      return "admin";
    }
    return "user";
  }

  getUserIdentifier(user) {
    if (!user) {
      return null;
    }

    const candidate = user._id || user.id || user.email || null;
    if (candidate === null || candidate === undefined) {
      return null;
    }

    if (
      typeof candidate === "object" &&
      candidate !== null &&
      candidate.toString
    ) {
      return candidate.toString();
    }

    return String(candidate);
  }

  getClientLookupKey(data) {
    if (!data || typeof data !== "object") {
      return null;
    }

    const candidate =
      data?.clientId ||
      data?.username ||
      data?.conversationId ||
      data?.conversation_id ||
      data?.clientUsername ||
      data?.client ||
      data?.id ||
      null;
    return candidate || null;
  }

  getMessageConversationKey(data) {
    if (!data || typeof data !== "object") {
      return null;
    }

    let candidate =
      data.conversationId ||
      data.conversation_id ||
      data.clientId ||
      data.username ||
      data.clientUsername ||
      data.client ||
      data?.clients?.[0]?.conversationId ||
      data?.clients?.[0]?.username ||
      data?.clients?.[0]?.clientId ||
      null;

    if (!candidate && data.url) {
      const match = String(data.url).match(/\/inbox\/([^/?#]+)/i);
      if (match && match[1]) {
        candidate = match[1];
      }
    }

    return candidate ? String(candidate).trim().replace(/^@/, "") : null;
  }

  normalizeClientLookupValue(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    if (typeof value === "object") {
      const nestedCandidates = [
        value.username,
        value.clientUsername,
        value.client,
        value.conversationId,
        value.conversation_id,
        value.id,
        value._id,
        value.clientKey,
        value.name,
        value.displayName,
        value.value,
        value?.profile?.username,
        value?.user?.username,
      ];

      for (const nestedValue of nestedCandidates) {
        const normalized = this.normalizeClientLookupValue(nestedValue);
        if (normalized) {
          return normalized;
        }
      }
      return null;
    }

    return String(value)
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  getClientLookupVariants(value) {
    const normalized = this.normalizeClientLookupValue(value);
    if (!normalized) {
      return [];
    }

    const variants = new Set([normalized]);
    const stripped = normalized.replace(
      /^(user|client|conversation|conv|seller|profile|inbox|chat)([_-]?)/,
      "",
    );
    if (stripped && stripped !== normalized) {
      variants.add(stripped);
    }

    const withoutTrailingRole = normalized.replace(
      /(?:[_-]?(?:user|client|seller|profile|conversation|conv|inbox|chat))$/,
      "",
    );
    if (withoutTrailingRole && withoutTrailingRole !== normalized) {
      variants.add(withoutTrailingRole);
    }

    return Array.from(variants).filter(Boolean);
  }

  clientMatchesAssignedIds(client, assignedIds = []) {
    const candidateKeys = [
      client?._id,
      client?.id,
      client?.clientId,
      client?.client_id,
      client?.clientKey,
      client?.username,
      client?.clientUsername,
      client?.client,
      client?.profile?.username,
      client?.user?.username,
    ]
      .flatMap((item) => this.getClientLookupVariants(item))
      .map((item) => this.normalizeClientLookupValue(item))
      .filter(Boolean);

    if (candidateKeys.length === 0) {
      return false;
    }

    const normalizedAssignedIds = (assignedIds || [])
      .flatMap((item) => this.getClientLookupVariants(item))
      .map((item) => this.normalizeClientLookupValue(item))
      .filter(Boolean);

    if (normalizedAssignedIds.length === 0) {
      return false;
    }

    const assignedIdSet = new Set(normalizedAssignedIds);
    return candidateKeys.some((candidateKey) =>
      assignedIdSet.has(candidateKey),
    );
  }

  payloadMatchesAssignedIds(payload, assignedIds = []) {
    if (!payload || !Array.isArray(assignedIds) || assignedIds.length === 0) {
      return false;
    }

    const clientCandidate = {
      _id: payload._id,
      id: payload.id,
      clientKey:
        payload.clientKey ||
        payload.conversationId ||
        payload.conversation_id ||
        payload.username ||
        payload.clientUsername ||
        payload.client ||
        null,
      conversationId: payload.conversationId || payload.conversation_id,
      username:
        payload.username || payload.clientUsername || payload.client || null,
      clientUsername: payload.clientUsername,
      client: payload.client,
      name: payload.name,
      displayName: payload.displayName,
    };

    if (
      payload.clients &&
      Array.isArray(payload.clients) &&
      payload.clients.length > 0
    ) {
      if (
        payload.clients.some((client) =>
          this.clientMatchesAssignedIds(client, assignedIds),
        )
      ) {
        return true;
      }
    }

    return this.clientMatchesAssignedIds(clientCandidate, assignedIds);
  }

  async filterMessagePayloadsForUser(
    user,
    payloads = [],
    targetConversationId = null,
  ) {
    const isAdmin = user && this.normalizeRole(user.role, user) === "admin";
    const normalizedTarget =
      this.normalizeClientLookupValue(targetConversationId);

    if (isAdmin) {
      const allPayloads = (payloads || []).map((payload) =>
        payload ? JSON.parse(JSON.stringify(payload)) : payload,
      );
      if (!normalizedTarget) {
        return allPayloads;
      }
      return allPayloads.filter((payload) =>
        this.payloadMatchesConversationTarget(payload, normalizedTarget),
      );
    }

    const assignedIds = await this.getAssignedClientIds(user);
    if (!Array.isArray(assignedIds) || assignedIds.length === 0) {
      return [];
    }

    const filteredPayloads = [];

    for (const payload of payloads || []) {
      if (!payload) {
        continue;
      }

      const matchesAssigned = this.payloadMatchesAssignedIds(
        payload,
        assignedIds,
      );
      if (!matchesAssigned) {
        continue;
      }

      if (normalizedTarget) {
        if (!this.payloadMatchesConversationTarget(payload, normalizedTarget)) {
          continue;
        }
      }

      const copy = JSON.parse(JSON.stringify(payload));
      copy.messages = (copy.messages || []).map((m) => {
        const out = { ...m };
        if (out.editedText) {
          out.text = out.editedText;
          out.isEdited = true;
        }
        if (out.original_text) delete out.original_text;
        if (out.originalText) delete out.originalText;
        return out;
      });
      filteredPayloads.push(copy);
    }

    return filteredPayloads;
  }

  async filterClientListForUser(user, clientListPayload) {
    const isAdmin = user && this.normalizeRole(user.role, user) === "admin";
    if (!clientListPayload) {
      return clientListPayload;
    }

    const sanitizedPayload = {
      ...clientListPayload,
      clients: this.sanitizeClientListClients(clientListPayload.clients || []),
    };

    const clientCount = Array.isArray(sanitizedPayload.clients)
      ? sanitizedPayload.clients.length
      : 0;

    if (isAdmin) {
      return sanitizedPayload;
    }

    const assignedIds = await this.getAssignedClientIds(user);

    if (!assignedIds.length) {
      return {
        ...clientListPayload,
        clients: [],
      };
    }

    const filteredClients = (sanitizedPayload.clients || []).filter((client) =>
      this.clientMatchesAssignedIds(client, assignedIds),
    );

    return {
      ...sanitizedPayload,
      clients: filteredClients,
    };
  }

  async getUserById(userId) {
    const coll = await this.getMongoUsersCollection();
    if (!coll || !userId) {
      return null;
    }
    return coll.findOne({ _id: userId });
  }

  async getAssignedClientIds(user) {
    if (!user) {
      return [];
    }

    const coll = await this.getMongoAssignmentsCollection();
    if (!coll) {
      return [];
    }

    const userId = this.getUserIdentifier(user);
    if (!userId) {
      return [];
    }

    const docs = await coll.find({ userId }).toArray();
    return docs.map((doc) => doc.clientId).filter(Boolean);
  }

  async setUserClientAssignments(userId, clientIds) {
    const coll = await this.getMongoAssignmentsCollection();
    const normalizedUserId = this.getUserIdentifier({ _id: userId });
    if (!normalizedUserId) {
      return false;
    }

    const normalizedIds = Array.from(
      new Set(
        (clientIds || [])
          .filter(Boolean)
          .map((value) => this.getUserIdentifier({ _id: value })),
      ),
    );
    await coll.deleteMany({ userId: normalizedUserId });

    if (normalizedIds.length === 0) {
      return true;
    }

    const docs = normalizedIds.map((clientId) => ({
      _id: `${normalizedUserId}:${clientId}`,
      userId: normalizedUserId,
      clientId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    await coll.insertMany(docs);
    return true;
  }

  async getAssignmentsForUser(userId) {
    const coll = await this.getMongoAssignmentsCollection();
    const normalizedUserId = this.getUserIdentifier({ _id: userId });
    if (!normalizedUserId) {
      return [];
    }

    return coll.find({ userId: normalizedUserId }).toArray();
  }

  async canUserAccessClient(user, clientKey) {
    if (!user) {
      return false;
    }
    if (this.normalizeRole(user.role, user) === "admin") {
      return true;
    }

    if (!clientKey) {
      return false;
    }

    const assignedIds = await this.getAssignedClientIds(user);
    if (!assignedIds.length) {
      return false;
    }

    return this.clientMatchesAssignedIds(
      {
        _id: clientKey,
        id: clientKey,
        clientKey,
        conversationId: clientKey,
        username: clientKey,
        clientUsername: clientKey,
        client: clientKey,
      },
      assignedIds,
    );
  }

  looksLikeFiverrSlug(value) {
    const slug = String(value || "")
      .trim()
      .replace(/^@/, "");
    if (!slug || slug.includes(" ")) {
      return false;
    }
    if (/^name:/i.test(slug) || /^row:/i.test(slug)) {
      return false;
    }
    if (/^client-\d+$/i.test(slug)) {
      return false;
    }
    return /^[a-zA-Z0-9_-]+$/.test(slug);
  }

  conversationLookupMatches(normalizedTarget, normalizedValue) {
    if (!normalizedTarget || !normalizedValue) {
      return false;
    }
    if (normalizedTarget === normalizedValue) {
      return true;
    }
    return (
      normalizedValue.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedValue)
    );
  }

  payloadMatchesConversationTarget(payload, normalizedTarget) {
    if (!normalizedTarget) {
      return true;
    }
    if (!payload) {
      return false;
    }

    const candidateValues = [
      payload?.conversationId,
      payload?.conversation_id,
      payload?.username,
      payload?.clientUsername,
      payload?.client,
      payload?.clients?.[0]?.conversationId,
      payload?.clients?.[0]?.conversation_id,
      payload?.clients?.[0]?.username,
      payload?.clients?.[0]?.clientUsername,
      payload?.clients?.[0]?.client,
      payload?.clients?.[0]?.id,
      payload?.clients?.[0]?.clientId,
    ].filter(Boolean);

    return candidateValues.some((value) => {
      const normalizedValue = this.normalizeClientLookupValue(value);
      return this.conversationLookupMatches(normalizedTarget, normalizedValue);
    });
  }

  sanitizeClientListClients(clients) {
    if (!Array.isArray(clients) || clients.length === 0) {
      return [];
    }

    const slugUsage = new Map();
    for (const client of clients) {
      const slug = [
        client?.username,
        client?.conversationId,
        client?.conversation_id,
      ]
        .map((value) => String(value || "").trim())
        .find((value) => this.looksLikeFiverrSlug(value));
      if (!slug) continue;
      slugUsage.set(
        slug.toLowerCase(),
        (slugUsage.get(slug.toLowerCase()) || 0) + 1,
      );
    }

    return clients.map((client, index) => {
      const copy = { ...(client || {}) };
      let slug = [copy.username, copy.conversationId, copy.conversation_id]
        .map((value) => String(value || "").trim())
        .find((value) => this.looksLikeFiverrSlug(value));

      if (slug && (slugUsage.get(slug.toLowerCase()) || 0) > 1) {
        const sameSlugRows = clients.filter((row) => {
          const rowSlug = [
            row?.username,
            row?.conversationId,
            row?.conversation_id,
          ]
            .map((value) => String(value || "").trim())
            .find((value) => this.looksLikeFiverrSlug(value));
          return rowSlug && rowSlug.toLowerCase() === slug.toLowerCase();
        });
        const uniqueNames = new Set(
          sameSlugRows
            .map((row) => String(row?.name || row?.displayName || "").trim())
            .filter(Boolean),
        );
        if (uniqueNames.size > 1) {
          slug = null;
          if (
            copy.conversationId &&
            String(copy.conversationId).toLowerCase() ===
              String(sameSlugRows[0]?.conversationId || "").toLowerCase()
          ) {
            copy.conversationId = null;
            copy.conversation_id = null;
          }
        }
      }

      const nameKey = copy.name
        ? `name:${String(copy.name).trim().toLowerCase()}`
        : null;
      const rowKey = slug || nameKey || `row:${index}`;
      const username = slug || copy.username || copy.name || rowKey;

      return {
        ...copy,
        _id: rowKey,
        id: rowKey,
        clientKey: rowKey,
        username,
        conversationId: slug || copy.conversationId || null,
        name: copy.name || copy.displayName || username || "Unknown",
        displayName: copy.displayName || copy.name || username || "Unknown",
      };
    });
  }

  buildClientDocument(data) {
    const username =
      data.username || data.clientUsername || data.client || null;
    const conversationId =
      data.conversationId || data.conversation_id || username || null;
    const candidateKey =
      data._id ||
      data.id ||
      username ||
      conversationId ||
      `client_${Date.now()}`;

    const clientKey = String(candidateKey);

    return {
      _id: clientKey,
      id: String(data.id || clientKey),
      clientKey,
      username,
      conversationId,
      name: data.name || data.clientName || username || "Unknown",
      company: data.company || data.clientCompany || null,
      country: data.country || null,
      language: data.language || null,
      avatarUrl: data.avatarUrl || data.avatar_url || null,
      avatar_url: data.avatarUrl || data.avatar_url || null,
      metadata: data.metadata || data.clientData || {},
      created_at: data.created_at || data.createdAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...data,
    };
  }

  ensureLocalUsersStore() {
    try {
      const dir = path.dirname(this.localUsersFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.localUsersFilePath)) {
        fs.writeFileSync(
          this.localUsersFilePath,
          JSON.stringify({ users: [] }, null, 2),
        );
      }

      this.loadLocalUsersStore();
    } catch (error) {}
  }

  loadLocalUsersStore() {
    try {
      if (!fs.existsSync(this.localUsersFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.localUsersFilePath, "utf8");
      const parsed = JSON.parse(raw);
      const users = Array.isArray(parsed?.users) ? parsed.users : [];

      this.localUsers = new Map();
      for (const user of users) {
        if (user?.email) {
          this.localUsers.set(user.email.toLowerCase().trim(), user);
        }
      }
    } catch (error) {}
  }

  persistLocalUsersStore() {
    try {
      const users = Array.from(this.localUsers.values()).map((user) => ({
        ...user,
        authTokens: user.authTokens || [],
      }));

      fs.writeFileSync(
        this.localUsersFilePath,
        JSON.stringify({ users }, null, 2),
      );
    } catch (error) {}
  }

  async hashPassword(password, salt = null) {
    const actualSalt = salt || crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, actualSalt, 64);
    return {
      salt: actualSalt,
      hash: derivedKey.toString("hex"),
    };
  }

  async verifyPassword(password, salt, hash) {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return derivedKey.toString("hex") === hash;
  }

  generateAuthToken() {
    return crypto.randomBytes(32).toString("hex");
  }

  async getUserByEmail(email) {
    const coll = await this.getMongoUsersCollection();
    if (coll) {
      return coll.findOne({ email: email.toLowerCase().trim() });
    }

    const normalizedEmail = email.toLowerCase().trim();
    return this.localUsers.get(normalizedEmail) || null;
  }

  async getUserByToken(token) {
    const coll = await this.getMongoUsersCollection();
    if (coll) {
      const now = new Date();
      return coll.findOne({
        authTokens: {
          $elemMatch: {
            token: token,
            expires: { $gt: now },
          },
        },
      });
    }

    const user = Array.from(this.localUsers.values()).find((entry) =>
      (entry.authTokens || []).some(
        (item) => item.token === token && new Date(item.expires) > new Date(),
      ),
    );
    return user || null;
  }

  async addAuthTokenToUser(email, token) {
    const coll = await this.getMongoUsersCollection();
    if (!coll) {
      const normalizedEmail = email.toLowerCase().trim();
      const user = this.localUsers.get(normalizedEmail);
      if (!user) {
        return false;
      }
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      user.authTokens = user.authTokens || [];
      user.authTokens.push({ token, expires });
      user.updated_at = new Date().toISOString();
      this.localUsers.set(normalizedEmail, user);
      this.persistLocalUsersStore();
      return true;
    }

    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const result = await coll.updateOne(
      { email: email.toLowerCase().trim() },
      {
        $push: {
          authTokens: {
            token,
            expires,
          },
        },
        $set: { updated_at: new Date().toISOString() },
      },
      { upsert: false },
    );
    return result.modifiedCount > 0;
  }

  async invalidateAuthToken(token) {
    const coll = await this.getMongoUsersCollection();
    if (!coll) {
      for (const [email, user] of this.localUsers.entries()) {
        const nextTokens = (user.authTokens || []).filter(
          (item) => item.token !== token,
        );
        if (nextTokens.length !== (user.authTokens || []).length) {
          user.authTokens = nextTokens;
          this.localUsers.set(email, user);
          return true;
        }
      }
      return false;
    }

    const result = await coll.updateOne(
      { "authTokens.token": token },
      { $pull: { authTokens: { token } } },
    );
    return result.modifiedCount > 0;
  }

  async createUser({ username, email, password }) {
    const coll = await this.getMongoUsersCollection();
    const normalizedEmail = email.toLowerCase().trim();

    if (coll) {
      const existingUser = await coll.findOne({ email: normalizedEmail });
      if (existingUser) {
        throw new Error("User already exists with that email");
      }

      const { salt, hash } = await this.hashPassword(password);
      const user = {
        username: username.trim(),
        email: normalizedEmail,
        passwordHash: hash,
        passwordSalt: salt,
        role: this.isAdminEmail(normalizedEmail) ? "admin" : "user",
        authTokens: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await coll.insertOne(user);
      return { username: user.username, email: user.email };
    }

    const existingUser = this.localUsers.get(normalizedEmail);
    if (existingUser) {
      throw new Error("User already exists with that email");
    }

    const { salt, hash } = await this.hashPassword(password);
    const user = {
      username: username.trim(),
      email: normalizedEmail,
      passwordHash: hash,
      passwordSalt: salt,
      role: this.isAdminEmail(normalizedEmail) ? "admin" : "user",
      authTokens: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.localUsers.set(normalizedEmail, user);
    this.persistLocalUsersStore();
    return { username: user.username, email: user.email };
  }

  async authenticateUser({ email, password }) {
    const user = await this.getUserByEmail(email);
    if (!user) {
      return null;
    }
    const valid = await this.verifyPassword(
      password,
      user.passwordSalt,
      user.passwordHash,
    );
    return valid ? user : null;
  }

  async sendJsonResponse(res, status, payload) {
    const body = JSON.stringify(payload || {});
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400",
    });
    res.end(body);
  }

  normalizeString(value) {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value).trim();
  }

  async parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        if (!body) {
          resolve({});
          return;
        }

        const trimmedBody = body.trim();

        if (!trimmedBody) {
          resolve({});
          return;
        }

        try {
          if (trimmedBody.startsWith("{") || trimmedBody.startsWith("[")) {
            try {
              resolve(JSON.parse(trimmedBody));
              return;
            } catch {
              const parseObjectLikePayload = (input) => {
                const trimmedInput = input.trim();
                if (
                  !trimmedInput.startsWith("{") ||
                  !trimmedInput.endsWith("}")
                ) {
                  throw new Error("Unsupported object format");
                }

                const content = trimmedInput.slice(1, -1).trim();
                if (!content) {
                  return {};
                }

                const entries = content
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean)
                  .map((part) => {
                    const separatorIndex = part.indexOf(":");
                    if (separatorIndex === -1) {
                      return null;
                    }

                    const rawKey = part.slice(0, separatorIndex).trim();
                    const rawValue = part.slice(separatorIndex + 1).trim();
                    const normalizedKey = rawKey.replace(/^['"]|['"]$/g, "");

                    let normalizedValue = rawValue;
                    if (/^(true|false)$/i.test(normalizedValue)) {
                      normalizedValue =
                        normalizedValue.toLowerCase() === "true";
                    } else if (/^-?\d+(?:\.\d+)?$/.test(normalizedValue)) {
                      normalizedValue = Number(normalizedValue);
                    } else if (normalizedValue === "null") {
                      normalizedValue = null;
                    } else {
                      normalizedValue = normalizedValue.replace(
                        /^['"]|['"]$/g,
                        "",
                      );
                    }

                    return [normalizedKey, normalizedValue];
                  })
                  .filter(Boolean);

                return Object.fromEntries(entries);
              };

              resolve(parseObjectLikePayload(trimmedBody));
              return;
            }
          }

          if (trimmedBody.includes("=")) {
            const parsed = Object.fromEntries(new URLSearchParams(trimmedBody));
            resolve(parsed);
            return;
          }

          resolve({ value: trimmedBody });
        } catch (error) {
          try {
            resolve(JSON.parse(trimmedBody.replace(/'/g, '"')));
          } catch (nestedError) {
            reject(nestedError);
          }
        }
      });
      req.on("error", reject);
    });
  }

  async handleRegister(req, res, body) {
    const email = this.normalizeString(body?.email).toLowerCase();
    const username = this.normalizeString(body?.username);
    const password = this.normalizeString(body?.password);

    if (!email || !username || !password) {
      return this.sendJsonResponse(res, 400, {
        error: "Missing username, email, or password",
      });
    }

    try {
      const user = await this.createUser({ username, email, password });
      const token = this.generateAuthToken();
      await this.addAuthTokenToUser(email, token);
      return this.sendJsonResponse(res, 201, {
        success: true,
        token,
        username: user.username,
        email: user.email,
        role: this.normalizeRole(user.role, user),
      });
    } catch (error) {
      return this.sendJsonResponse(res, 400, {
        error: error.message || "Failed to register user",
      });
    }
  }

  async handleLogin(req, res, body) {
    const email = this.normalizeString(body?.email).toLowerCase();
    const password = this.normalizeString(body?.password);

    if (!email || !password) {
      return this.sendJsonResponse(res, 400, {
        error: "Missing email or password",
      });
    }

    try {
      const user = await this.authenticateUser({ email, password });
      if (!user) {
        return this.sendJsonResponse(res, 401, {
          error: "Invalid email or password",
        });
      }

      const token = this.generateAuthToken();
      await this.addAuthTokenToUser(email, token);
      return this.sendJsonResponse(res, 200, {
        success: true,
        token,
        username: user.username,
        email: user.email,
        role: this.normalizeRole(user.role, user),
      });
    } catch (error) {
      return this.sendJsonResponse(res, 500, {
        error: error.message || "Failed to log in",
      });
    }
  }

  async handleMe(req, res, token) {
    if (!token) {
      return this.sendJsonResponse(res, 401, {
        error: "Missing auth token",
      });
    }

    const user = await this.getUserByToken(token);
    if (!user) {
      return this.sendJsonResponse(res, 401, {
        error: "Invalid or expired token",
      });
    }

    return this.sendJsonResponse(res, 200, {
      success: true,
      id: user._id || user.id || null,
      username: user.username,
      email: user.email,
      role: this.normalizeRole(user.role, user),
    });
  }

  async handleLogout(req, res, token) {
    if (!token) {
      return this.sendJsonResponse(res, 401, {
        error: "Missing auth token",
      });
    }

    const removed = await this.invalidateAuthToken(token);
    if (!removed) {
      return this.sendJsonResponse(res, 400, {
        error: "Token invalid or already logged out",
      });
    }

    return this.sendJsonResponse(res, 200, {
      success: true,
      message: "Logged out successfully",
    });
  }

  async handleMyAssignments(req, res, token) {
    if (!token) {
      return this.sendJsonResponse(res, 401, { error: "Missing auth token" });
    }

    const user = await this.getUserByToken(token);
    if (!user) {
      return this.sendJsonResponse(res, 401, {
        error: "Invalid or expired token",
      });
    }

    const assignments = await this.getAssignmentsForUser(
      this.getUserIdentifier(user),
    );
    return this.sendJsonResponse(res, 200, {
      assignments,
      clientIds: assignments.map((item) => item.clientId).filter(Boolean),
    });
  }

  async requireAdmin(req, res, token) {
    if (!token) {
      await this.sendJsonResponse(res, 401, { error: "Missing auth token" });
      return null;
    }

    const user = await this.getUserByToken(token);
    if (!user || this.normalizeRole(user.role, user) !== "admin") {
      await this.sendJsonResponse(res, 403, { error: "Admin access required" });
      return null;
    }

    return user;
  }

  async handleAdminClients(req, res, token) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoClientsCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { clients: [] });
    }

    const clients = await coll
      .find({ _id: { $ne: "client_list" } })
      .sort({ updated_at: -1 })
      .toArray();
    return this.sendJsonResponse(res, 200, { clients });
  }

  async handleClients(req, res, token) {
    const coll = await this.getMongoClientsCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { clients: [] });
    }

    const clients = await coll
      .find({ _id: { $ne: "client_list" } })
      .sort({ updated_at: -1 })
      .toArray();

    let user = null;
    if (token) {
      try {
        user = await this.getUserByToken(token);
      } catch (err) {
        user = null;
      }
    }

    // If requester is admin, return full list; otherwise return filtered list
    const isAdmin = user && this.normalizeRole(user.role, user) === "admin";
    if (isAdmin) {
      return this.sendJsonResponse(res, 200, { clients });
    }

    // Non-admin: filter to assigned clients only
    const payload = { clients };
    const filtered = await this.filterClientListForUser(user, payload);
    return this.sendJsonResponse(res, 200, { clients: filtered.clients || [] });
  }

  async handleAdminClientById(req, res, token, clientId) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoClientsCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 404, { error: "Client not found" });
    }

    if (req.method === "PUT") {
      const body = await this.parseJsonBody(req);
      const updateDoc = { ...body, updated_at: new Date().toISOString() };
      const result = await coll.updateOne(
        { _id: clientId },
        { $set: updateDoc },
        { upsert: false },
      );
      if (!result.matchedCount) {
        return this.sendJsonResponse(res, 404, { error: "Client not found" });
      }
      const updated = await coll.findOne({ _id: clientId });
      return this.sendJsonResponse(res, 200, { client: updated });
    }

    if (req.method === "DELETE") {
      const result = await coll.deleteOne({ _id: clientId });
      if (!result.deletedCount) {
        return this.sendJsonResponse(res, 404, { error: "Client not found" });
      }
      const msgColl = await this.getMongoMessagesCollection();
      if (msgColl) {
        await msgColl.deleteMany({ clientId });
      }
      return this.sendJsonResponse(res, 200, { success: true });
    }

    return this.sendJsonResponse(res, 405, { error: "Method not allowed" });
  }

  async handleAdminMessages(req, res, token) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoMessagesCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { messages: [] });
    }

    const messages = await coll.find({}).sort({ updated_at: -1 }).toArray();
    return this.sendJsonResponse(res, 200, { messages });
  }

  async handleAdminMessageById(req, res, token, messageId) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoMessagesCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 404, { error: "Message not found" });
    }

    if (req.method === "PUT") {
      const body = await this.parseJsonBody(req);
      const existing = await coll.findOne({ _id: messageId });
      if (!existing) {
        return this.sendJsonResponse(res, 404, { error: "Message not found" });
      }

      const updateDoc = { ...body, updated_at: new Date().toISOString() };

      // If admin updates the text, preserve original text and save editedText
      if (body.text !== undefined && body.text !== null) {
        if (!existing.original_text && existing.text) {
          updateDoc.original_text = existing.text;
        }
        updateDoc.editedText = body.text;
        updateDoc.text = body.text;
        updateDoc.edited_by =
          user._id || user.id || user.email || user.username || null;
        updateDoc.edited_at = new Date().toISOString();
      }

      const result = await coll.updateOne(
        { _id: messageId },
        { $set: updateDoc },
        { upsert: false },
      );
      if (!result.matchedCount) {
        return this.sendJsonResponse(res, 404, { error: "Message not found" });
      }
      const updated = await coll.findOne({ _id: messageId });

      // Broadcast update to connected clients
      try {
        const payload = {
          conversationId: updated.conversationId,
          message: updated,
        };
        this.broadcastToExpoClients({ type: "message_updated", data: payload });
        for (const [sid, desktopWs] of this.connectedClients.entries()) {
          if (this.clientTypes.get(sid) === "desktop") {
            try {
              desktopWs.send(
                JSON.stringify({ type: "message_updated", data: payload }),
              );
            } catch (error) {}
          }
        }
      } catch (err) {}

      return this.sendJsonResponse(res, 200, { message: updated });
    }

    if (req.method === "DELETE") {
      const existing = await coll.findOne({ _id: messageId });
      if (!existing) {
        return this.sendJsonResponse(res, 404, { error: "Message not found" });
      }

      const result = await coll.deleteOne({ _id: messageId });
      if (!result.deletedCount) {
        return this.sendJsonResponse(res, 404, { error: "Message not found" });
      }

      // Broadcast deletion to connected clients
      try {
        const payload = { conversationId: existing.conversationId, messageId };
        this.broadcastToExpoClients({ type: "message_deleted", data: payload });
        for (const [sid, desktopWs] of this.connectedClients.entries()) {
          if (this.clientTypes.get(sid) === "desktop") {
            try {
              desktopWs.send(
                JSON.stringify({ type: "message_deleted", data: payload }),
              );
            } catch (error) {}
          }
        }
      } catch (err) {}

      return this.sendJsonResponse(res, 200, { success: true });
    }

    return this.sendJsonResponse(res, 405, { error: "Method not allowed" });
  }

  async handleAdminUsers(req, res, token) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoUsersCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { users: [] });
    }

    const users = await coll
      .find({})
      .project({ passwordHash: 0, passwordSalt: 0, authTokens: 0 })
      .sort({ created_at: -1 })
      .toArray();
    return this.sendJsonResponse(res, 200, { users });
  }

  async handleAdminAssignments(req, res, token) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    if (req.method === "POST") {
      const body = await this.parseJsonBody(req);

      const success = await this.setUserClientAssignments(
        body.userId,
        body.clientIds || [],
      );
      if (!success) {
        return this.sendJsonResponse(res, 400, {
          error: "Unable to save assignments",
        });
      }
      const assignments = await this.getAssignmentsForUser(body.userId);

      return this.sendJsonResponse(res, 200, { assignments });
    }

    const coll = await this.getMongoAssignmentsCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { assignments: [] });
    }

    const assignments = await coll.find({}).sort({ updated_at: -1 }).toArray();
    return this.sendJsonResponse(res, 200, { assignments });
  }

  async handleUserActivities(req, res, token) {
    if (!token) {
      return this.sendJsonResponse(res, 401, { error: "Missing auth token" });
    }

    const user = await this.getUserByToken(token);
    if (!user) {
      return this.sendJsonResponse(res, 401, {
        error: "Invalid or expired token",
      });
    }

    if (req.method === "POST") {
      const body = await this.parseJsonBody(req);
      await this.logUserActivity(req, user, body || {});
      return this.sendJsonResponse(res, 200, { success: true });
    }

    return this.sendJsonResponse(res, 405, { error: "Method not allowed" });
  }

  async handleAdminActivities(req, res, token) {
    const user = await this.requireAdmin(req, res, token);
    if (!user) {
      return;
    }

    const coll = await this.getMongoActivitiesCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { activities: [] });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams;
    const userId = String(query.get("userId") || "").trim();
    const activityType = String(query.get("activityType") || "")
      .trim()
      .toLowerCase();
    const limitRaw = parseInt(String(query.get("limit") || "200"), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(limitRaw, 1000))
      : 200;

    const filter = { role: { $ne: "admin" } };
    if (userId) {
      filter.userId = userId;
    }
    if (activityType) {
      filter.activityType = activityType;
    }

    const activities = await coll
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    return this.sendJsonResponse(res, 200, { activities });
  }

  /**
   * Load seller profiles from MongoDB or JSON file
   */
  parseSellerProfilesFromObject(data) {
    const profiles = new Map();
    if (typeof data !== "object" || data === null) {
      return profiles;
    }

    for (const value of Object.values(data)) {
      if (typeof value === "object" && value !== null && value.username) {
        profiles.set(value.username, value);
      }
    }
    return profiles;
  }

  pickLatestSellerProfile(profiles) {
    let latest = null;
    let latestTime = "";
    for (const profile of profiles.values()) {
      const updatedAt = profile.updated_at || "";
      if (updatedAt > latestTime) {
        latestTime = updatedAt;
        latest = profile;
      }
    }
    return latest;
  }

  async loadSellerProfilesFromMongo(coll) {
    const profiles = new Map();
    const cursor = coll.find({});

    for await (const doc of cursor) {
      const username =
        doc.username || (typeof doc._id === "string" ? doc._id : null);
      if (username) {
        const entry = { ...doc };
        delete entry._id;
        entry.username = username;
        profiles.set(username, entry);
      }
    }

    return profiles;
  }

  async migrateSellerProfilesFromJsonFiles() {
    const profiles = new Map();
    const jsonPath = path.join(__dirname, "seller_profiles.json");

    try {
      if (fs.existsSync(jsonPath)) {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        for (const [username, profile] of this.parseSellerProfilesFromObject(
          data,
        )) {
          profiles.set(username, profile);
        }
      } else {
        const legacyPath = path.join(__dirname, "seller_profile.json");
        if (fs.existsSync(legacyPath)) {
          const single = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
          if (
            typeof single === "object" &&
            single !== null &&
            single.username
          ) {
            profiles.set(single.username, single);
          }
        }
      }
    } catch (error) {}

    return profiles;
  }

  async loadSellerProfiles() {
    const coll = await this.getMongoProfilesCollection();
    if (!coll) {
      this.sellerProfiles = new Map();
      this.sellerProfile = null;
      return;
    }

    try {
      let profiles = await this.loadSellerProfilesFromMongo(coll);

      if (profiles.size === 0) {
        const migrated = await this.migrateSellerProfilesFromJsonFiles();
        if (migrated.size > 0) {
          this.sellerProfiles = migrated;
          await this.saveSellerProfiles();
          profiles = migrated;
        }
      }

      this.sellerProfiles = profiles;
      this.sellerProfile = this.pickLatestSellerProfile(profiles);
    } catch (error) {
      this.sellerProfiles = new Map();
      this.sellerProfile = null;
    }
  }

  /**
   * Save seller profiles to MongoDB
   */
  async saveSellerProfiles() {
    if (this.sellerProfiles.size === 0) {
      return;
    }

    const coll = await this.getMongoProfilesCollection();
    if (!coll) {
      return;
    }

    try {
      for (const [username, doc] of this.sellerProfiles.entries()) {
        const payload = { ...doc };
        delete payload._id;
        await coll.replaceOne(
          { _id: username },
          { ...payload, _id: username },
          { upsert: true },
        );
      }
    } catch (error) {}
  }

  messageLooksFromMe(message) {
    if (!message) return false;
    if (message.isFromMe === true || message.isFromMe === "true") {
      return true;
    }
    const sender = String(message.senderUsername || message.sender || "")
      .trim()
      .toLowerCase();
    return sender === "me";
  }

  canonicalMessageId(message) {
    const raw = message?.id || message?._id || message?.messageId;
    if (!raw || /^message-\d+$/i.test(String(raw))) {
      return null;
    }
    let id = String(raw).trim();
    id = id.replace(
      /_[A-Z][a-z]{2}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*(?:AM|PM)$/i,
      "",
    );
    id = id.replace(/_\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/i, "");
    const fiverrCore = id.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{4,}-[a-f0-9]{12}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{4,}-[a-f0-9]{12})/i,
    );
    if (fiverrCore) {
      return fiverrCore[1].toLowerCase();
    }
    return id.toLowerCase();
  }

  async loadMessagesFromMongo() {
    const coll = await this.getMongoMessagesCollection();
    if (!coll) {
      return [];
    }

    try {
      const docs = await coll
        .find({})
        .sort({ timestamp: 1, created_at: 1 })
        .toArray();

      const isGeneric = (val) => {
        if (!val) return true;
        const norm = String(val)
          .trim()
          .toLowerCase()
          .replace(/^@/, "")
          .replace(/[^a-z0-9]+/g, "");
        return (
          !norm ||
          [
            "conversation",
            "default",
            "undefined",
            "null",
            "messages",
            "client",
            "objectobject",
          ].includes(norm) ||
          norm.startsWith("message")
        );
      };

      const grouped = new Map();
      for (const doc of docs) {
        const fromMe = this.messageLooksFromMe(doc);
        const senderValue = doc.senderUsername || doc.sender;
        const buyerSender =
          !fromMe &&
          !isGeneric(senderValue) &&
          String(senderValue).trim().toLowerCase() !== "me" &&
          String(senderValue).trim().toLowerCase() !== "client"
            ? senderValue
            : null;

        // Prefer the buyer/peer identity so seller ("me") rows that were
        // historically keyed under the seller username still land in the
        // client conversation for the first paint before extract.
        const conversationId =
          (!isGeneric(doc.clientUsername) ? doc.clientUsername : null) ||
          buyerSender ||
          (!isGeneric(doc.conversationId) ? doc.conversationId : null) ||
          (!isGeneric(doc.clientId) ? doc.clientId : null);

        if (!conversationId) {
          continue;
        }

        if (!grouped.has(conversationId)) {
          grouped.set(conversationId, {
            conversationId,
            messages: [],
            clients: [],
          });
        }

        const entry = grouped.get(conversationId);
        entry.messages.push({
          ...doc,
          text: doc.text || doc.content || doc.message || "",
          time: doc.timestamp || doc.time || doc.date,
          sender: fromMe ? "me" : doc.sender || buyerSender || conversationId,
          isFromMe: fromMe,
          clientUsername: doc.clientUsername || conversationId,
          conversationId,
        });
      }

      const clientColl = await this.getMongoClientsCollection();
      const payloads = [];

      for (const entry of grouped.values()) {
        let clientDoc = null;
        if (clientColl) {
          clientDoc = await clientColl.findOne({
            $or: [
              { _id: entry.conversationId },
              { username: entry.conversationId },
              { conversationId: entry.conversationId },
            ],
          });
        }

        payloads.push({
          conversationId: entry.conversationId,
          clients: clientDoc ? [clientDoc] : [],
          messages: entry.messages,
        });
      }

      return payloads;
    } catch (error) {
      return [];
    }
  }

  /**
   * Save messages to MongoDB
   */
  async saveMessagesToMongo(data) {
    const db = await this.getMongoDb();
    if (!db) {
      return;
    }

    const conversationId = this.getMessageConversationKey(data);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (!conversationId && messages.length === 0) {
      return;
    }

    try {
      const coll = db.collection(this.mongoMessagesColl);
      const clientColl = db.collection(this.mongoClientsColl);
      const clientCandidates = [data, ...(data.clients || [])].filter(Boolean);

      let clientDoc = null;
      const candidateKeys = Array.from(
        new Set(
          clientCandidates
            .map((candidate) => this.getClientLookupKey(candidate))
            .filter(Boolean),
        ),
      );

      for (const candidateKey of candidateKeys) {
        const existing = await clientColl.findOne({
          $or: [
            { _id: candidateKey },
            { username: candidateKey },
            { conversationId: candidateKey },
          ],
        });
        if (existing) {
          clientDoc = existing;
          break;
        }
      }

      if (!clientDoc && conversationId) {
        clientDoc = await clientColl.findOne({
          $or: [
            { _id: conversationId },
            { username: conversationId },
            { conversationId },
          ],
        });
      }

      const clientId = clientDoc?._id || clientDoc?.id || null;
      const clientKeyForId =
        conversationId || clientId || this.getClientLookupKey(data) || null;

      const isGeneric = (val) => {
        if (!val) return true;
        const norm = String(val)
          .trim()
          .toLowerCase()
          .replace(/^@/, "")
          .replace(/[^a-z0-9]+/g, "");
        return (
          !norm ||
          [
            "conversation",
            "default",
            "undefined",
            "null",
            "messages",
            "client",
            "objectobject",
          ].includes(norm) ||
          norm.startsWith("message")
        );
      };

      const peerConversationId =
        (!isGeneric(conversationId) ? conversationId : null) ||
        (!isGeneric(clientId) ? clientId : null) ||
        (!isGeneric(clientKeyForId) ? clientKeyForId : null);

      for (const [index, message] of messages.entries()) {
        const fromMe = this.messageLooksFromMe(message);
        const msgSender = message.senderUsername || message.sender;
        const isValidSpecificSender =
          msgSender &&
          !isGeneric(msgSender) &&
          String(msgSender).trim().toLowerCase() !== "me" &&
          String(msgSender).trim().toLowerCase() !== "client";

        // Buyer rows can refine the peer id. Seller/outgoing rows must stay on
        // the client conversation — never under the seller account username.
        const perMsgSenderId =
          !fromMe && isValidSpecificSender ? msgSender : null;

        const safeConversationId =
          (!isGeneric(perMsgSenderId) ? perMsgSenderId : null) ||
          peerConversationId ||
          (!isGeneric(this.getClientLookupKey(message))
            ? this.getClientLookupKey(message)
            : null);

        if (!safeConversationId) {
          continue;
        }

        const timestampValue =
          message.timestamp ||
          message.time ||
          message.date ||
          new Date().toISOString();

        const cleanMsgId =
          message.id && !String(message.id).startsWith("message-")
            ? String(message.id)
            : `msg_${index}`;

        // Keep Fiverr's native id on `id` so the app can dedupe against live
        // extracts. Use a stable conversation-scoped key for Mongo `_id`.
        const messageId = `${safeConversationId}_${cleanMsgId}`;
        const payload = {
          ...message,
          _id: messageId,
          id: cleanMsgId,
          clientId: safeConversationId,
          clientUsername: message.clientUsername || safeConversationId,
          conversationId: safeConversationId,
          sender: fromMe
            ? "me"
            : message.sender && message.sender !== "client"
              ? message.sender
              : safeConversationId,
          text: message.text || message.content || message.message || "",
          timestamp: timestampValue,
          isFromMe: fromMe,
          metadata: message.metadata || {},
          created_at:
            message.created_at || message.createdAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        await coll.updateOne(
          { _id: payload._id },
          { $set: payload },
          { upsert: true },
        );
      }
    } catch (error) {}
  }

  /**
   * Save client data to MongoDB
   */
  async saveClientDataToMongo(data) {
    const db = await this.getMongoDb();
    if (!db) {
      return;
    }

    const key = this.getClientLookupKey(data);
    if (!key) {
      return;
    }

    try {
      const coll = db.collection(this.mongoClientsColl);
      const payload = await this.buildClientDocument(data);
      await coll.updateOne(
        { _id: payload._id },
        { $set: payload },
        { upsert: true },
      );
    } catch (error) {}
  }

  /**
   * Save client list entries to MongoDB as individual client records
   */
  async saveClientListToMongo(data) {
    const db = await this.getMongoDb();
    if (!db) {
      return;
    }

    const clients = data.clients || [];
    if (!clients.length) {
      return;
    }

    try {
      const coll = db.collection(this.mongoClientsColl);
      for (const client of clients) {
        const payload = await this.buildClientDocument(client);
        payload.updated_at = new Date().toISOString();
        await coll.updateOne(
          { _id: payload._id },
          { $set: payload },
          { upsert: true },
        );
      }
    } catch (error) {}
  }

  /**
   * Rebuild in-memory client list from Mongo so Expo can paint immediately
   * after a server restart without waiting for a full inbox scrape.
   */
  async ensureClientListHydratedFromMongo() {
    if (
      this.storedClientList &&
      Array.isArray(this.storedClientList.clients) &&
      this.storedClientList.clients.length > 0
    ) {
      return this.storedClientList;
    }

    try {
      const coll = await this.getMongoClientsCollection();
      if (!coll) {
        return this.storedClientList;
      }

      const clients = await coll
        .find({ _id: { $ne: "client_list" } })
        .sort({ updated_at: -1 })
        .toArray();

      if (!Array.isArray(clients) || clients.length === 0) {
        return this.storedClientList;
      }

      this.storedClientList = {
        clients,
        timestamp: new Date().toISOString(),
        source: "mongo_hydrate",
      };
      return this.storedClientList;
    } catch (_error) {
      return this.storedClientList;
    }
  }

  /**
   * Get online usernames (browser sessions)
   */
  getOnlineUsernames() {
    return new Set(this.browserProfileBySession.values());
  }

  /**
   * Get seller profiles with online status
   */
  getSellerProfilesWithOnline() {
    const online = this.getOnlineUsernames();
    return Array.from(this.sellerProfiles.values()).map((profile) => ({
      ...profile,
      online: online.has(profile.username),
    }));
  }

  /**
   * Merge Mongo payloads with fresher in-memory extension extracts.
   */
  mergeTwoMessagePayloads(left, right) {
    const base = { ...(left || {}), ...(right || {}) };
    const combined = [
      ...(Array.isArray(left?.messages) ? left.messages : []),
      ...(Array.isArray(right?.messages) ? right.messages : []),
    ];

    const bySignature = new Map();

    for (const message of combined) {
      if (!message) continue;
      const fromMe = this.messageLooksFromMe(message);
      const normalized = {
        ...message,
        isFromMe: fromMe,
        sender: fromMe ? "me" : message.sender,
        clientUsername:
          message.clientUsername ||
          base.clientUsername ||
          base.conversationId ||
          this.getMessageConversationKey(base) ||
          null,
      };
      const canonicalId = this.canonicalMessageId(normalized);
      const text = String(
        normalized.text || normalized.content || normalized.message || "",
      )
        .trim()
        .toLowerCase();
      const signature = canonicalId
        ? `id:${canonicalId}`
        : `text:${text}|${fromMe ? "me" : "client"}|${normalized.timestamp || normalized.time || ""}`;
      const existing = bySignature.get(signature);
      if (!existing) {
        bySignature.set(signature, normalized);
        continue;
      }
      // Prefer seller/outgoing ownership and richer attachment payloads.
      const existingFromMe = this.messageLooksFromMe(existing);
      const preferIncoming =
        (fromMe && !existingFromMe) ||
        (Array.isArray(normalized.images) ? normalized.images.length : 0) >
          (Array.isArray(existing.images) ? existing.images.length : 0);
      bySignature.set(
        signature,
        preferIncoming
          ? { ...existing, ...normalized, isFromMe: fromMe || existingFromMe }
          : { ...normalized, ...existing, isFromMe: fromMe || existingFromMe },
      );
    }

    base.messages = Array.from(bySignature.values());
    base.conversationId =
      right?.conversationId ||
      left?.conversationId ||
      this.getMessageConversationKey(base);
    return base;
  }

  mergeMessagePayloadSources(persisted = [], inMemory = []) {
    const byConversation = new Map();

    for (const payload of [...(persisted || []), ...(inMemory || [])]) {
      if (!payload) continue;
      const key = this.normalizeClientLookupValue(
        this.getMessageConversationKey(payload),
      );
      if (!key) continue;

      const existing = byConversation.get(key);
      if (!existing) {
        byConversation.set(key, JSON.parse(JSON.stringify(payload)));
        continue;
      }
      byConversation.set(key, this.mergeTwoMessagePayloads(existing, payload));
    }

    return Array.from(byConversation.values());
  }

  /**
   * Handle message received
   */
  onMessageReceived(data) {
    const messageCount = (data.messages || []).length;

    const conversationId = this.getMessageConversationKey(data);
    if (messageCount === 0 && conversationId) {
      return;
    }

    const normalizedData = JSON.parse(JSON.stringify(data));
    const peerKey =
      this.getMessageConversationKey(normalizedData) ||
      normalizedData.clientUsername ||
      null;
    if (peerKey) {
      normalizedData.conversationId = peerKey;
      normalizedData.username = normalizedData.username || peerKey;
      normalizedData.clientUsername = normalizedData.clientUsername || peerKey;
      normalizedData.messages = (normalizedData.messages || []).map(
        (message) => {
          const fromMe = this.messageLooksFromMe(message);
          return {
            ...message,
            isFromMe: fromMe,
            sender: fromMe ? "me" : message.sender,
            conversationId: peerKey,
            clientUsername: message.clientUsername || peerKey,
          };
        },
      );
    }
    this.storedMessageData = normalizedData;
    const storageKeyRaw = this.getMessageConversationKey(normalizedData);
    const storageKey =
      this.normalizeClientLookupValue(storageKeyRaw) || storageKeyRaw;
    if (storageKey) {
      const existing =
        this.storedMessageDataByConversation.get(storageKey) ||
        (storageKeyRaw && storageKeyRaw !== storageKey
          ? this.storedMessageDataByConversation.get(storageKeyRaw)
          : null);
      const merged = existing
        ? this.mergeTwoMessagePayloads(existing, normalizedData)
        : normalizedData;
      this.storedMessageDataByConversation.set(storageKey, merged);
      if (storageKeyRaw && storageKeyRaw !== storageKey) {
        this.storedMessageDataByConversation.delete(storageKeyRaw);
      }
      this.storedMessageData = merged;
      this.emit("message_received", merged);
      this.broadcastToExpoClients({
        type: "message_data",
        data: merged,
      });
    } else {
      this.emit("message_received", data);
      this.broadcastToExpoClients({
        type: "message_data",
        data: data,
      });
    }

    // Save to MongoDB
    this.saveMessagesToMongo(
      storageKey
        ? this.storedMessageDataByConversation.get(storageKey)
        : normalizedData,
    ).catch((err) => {});
  }

  /**
   * Handle client data received
   */
  onClientDataReceived(data) {
    const normalizedData = JSON.parse(JSON.stringify(data));
    const key =
      this.getClientLookupKey(normalizedData) ||
      normalizedData.username ||
      normalizedData.conversationId ||
      "default";
    this.storedClientData.set(key, normalizedData);

    // Save to MongoDB
    this.saveClientDataToMongo(normalizedData).catch((err) => {});

    // Emit event
    this.emit("client_data_received", data);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "client_data",
      data: data,
    });
  }

  /**
   * Handle client list received
   */
  async onClientListReceived(data) {
    const normalizedData = JSON.parse(JSON.stringify(data || {}));
    const clients = Array.isArray(normalizedData.clients)
      ? normalizedData.clients
      : [];

    normalizedData.clients = this.sanitizeClientListClients(clients).map(
      (client) => {
        const payload = this.buildClientDocument(client);
        return {
          ...payload,
          ...client,
          _id: client._id || payload._id,
          id: client.id || payload.id,
          clientKey: client.clientKey || payload.clientKey,
          username: client.username || payload.username,
          conversationId: client.conversationId || payload.conversationId,
          updated_at: client.updated_at || payload.updated_at,
          created_at: client.created_at || payload.created_at,
        };
      },
    );

    // Store normalized data so Expo clients receive stable client IDs
    this.storedClientList = normalizedData;

    // Save to MongoDB
    this.saveClientListToMongo(normalizedData).catch((err) => {});

    // Emit event
    this.emit("client_list_received", normalizedData);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "client_list_data",
      data: normalizedData,
    });
  }

  /**
   * Handle new message detected
   */
  onNewMessageDetected(data) {
    // Store data
    this.storedNewMessages.push(JSON.parse(JSON.stringify(data)));
    if (this.storedNewMessages.length > 100) {
      this.storedNewMessages.shift();
    }

    // Emit event
    this.emit("new_message_detected", data);

    // Broadcast to Expo clients via WebSocket (if app is running)
    this.broadcastToExpoClients({
      type: "new_message_detected",
      data: data,
    });

    // Push to native + web PWA even when the app/tab is closed.
    this.sendPushNotificationForMessage(data).catch(() => {});
  }

  getMessagePushDedupeKey(messageData = {}) {
    const conversationId =
      messageData.conversationId ||
      messageData.clientUsername ||
      messageData.username ||
      "unknown";
    const text = String(
      messageData.messageText || messageData.lastMessage || "",
    )
      .trim()
      .slice(0, 80);
    return `${String(conversationId).toLowerCase()}::${text}`;
  }

  shouldSendMessagePush(messageData = {}) {
    if (messageData.historical === true) return false;
    if (messageData.isFromMe === true || messageData.fromMe === true) {
      return false;
    }

    const key = this.getMessagePushDedupeKey(messageData);
    const lastAt = this.recentMessagePushAlerts.get(key) || 0;
    const COOLDOWN_MS = 20 * 1000;
    if (Date.now() - lastAt < COOLDOWN_MS) {
      return false;
    }
    this.recentMessagePushAlerts.set(key, Date.now());

    if (this.recentMessagePushAlerts.size > 500) {
      const oldest = this.recentMessagePushAlerts.keys().next().value;
      this.recentMessagePushAlerts.delete(oldest);
    }
    return true;
  }

  async getMongoPushSubscriptionsCollection() {
    if (!this.mongodbUrl) return null;
    if (this.mongoPushSubscriptionsCollection) {
      return this.mongoPushSubscriptionsCollection;
    }
    try {
      await this.connectMongo();
      if (!this.mongoDb) return null;
      this.mongoPushSubscriptionsCollection =
        this.mongoDb.collection("push_subscriptions");
      try {
        await this.mongoPushSubscriptionsCollection.createIndex(
          { endpoint: 1 },
          { unique: true },
        );
      } catch (_) {}
      return this.mongoPushSubscriptionsCollection;
    } catch (error) {
      this.mongoPushSubscriptionsCollection = null;
      return null;
    }
  }

  async hydrateWebPushSubscriptions() {
    if (this.webPushHydrated) return;
    this.webPushHydrated = true;
    try {
      const coll = await this.getMongoPushSubscriptionsCollection();
      if (!coll) return;
      const rows = await coll.find({ type: "web" }).limit(2000).toArray();
      for (const row of rows) {
        if (!row?.endpoint || !row?.subscription) continue;
        this.webPushSubscriptions.set(row.endpoint, {
          type: "web",
          endpoint: row.endpoint,
          subscription: row.subscription,
          userId: row.userId || null,
          sessionId: row.sessionId || null,
          registeredAt: row.registeredAt || Date.now(),
        });
      }
    } catch (_) {}
  }

  async persistWebPushSubscription(record) {
    if (!record?.endpoint || !record?.subscription) return;
    this.webPushSubscriptions.set(record.endpoint, record);
    try {
      const coll = await this.getMongoPushSubscriptionsCollection();
      if (!coll) return;
      await coll.updateOne(
        { endpoint: record.endpoint },
        {
          $set: {
            type: "web",
            endpoint: record.endpoint,
            subscription: record.subscription,
            userId: record.userId || null,
            sessionId: record.sessionId || null,
            registeredAt: record.registeredAt || Date.now(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (_) {}
  }

  async removeWebPushSubscription(endpoint) {
    if (!endpoint) return;
    this.webPushSubscriptions.delete(endpoint);
    try {
      const coll = await this.getMongoPushSubscriptionsCollection();
      if (!coll) return;
      await coll.deleteOne({ endpoint });
    } catch (_) {}
  }

  async getAllPushTargets() {
    await this.hydrateWebPushSubscriptions();
    const targets = [];

    for (const token of this.pushTokens.keys()) {
      targets.push({ type: "expo", token });
    }
    for (const record of this.webPushSubscriptions.values()) {
      if (record?.subscription) {
        targets.push({ type: "web", subscription: record.subscription });
      }
    }
    return targets;
  }

  /**
   * Send push notification for new / unread message.
   * Works for native Expo tokens and web PWA subscriptions even when closed.
   */
  async sendPushNotificationForMessage(messageData) {
    if (!this.shouldSendMessagePush(messageData)) {
      return;
    }

    const {
      clientName,
      messageText,
      conversationId,
      username,
      clientUsername,
      isTest,
    } = messageData;

    const targets = await this.getAllPushTargets();
    if (targets.length === 0) {
      return;
    }

    const title = isTest
      ? "Test Notification"
      : `New message from ${clientName || "Client"}`;
    const body = isTest
      ? messageText || "This is a test notification!"
      : messageText || "You have a new unread message";

    const maxLength = 100;
    const truncatedBody =
      body.length > maxLength ? body.substring(0, maxLength - 3) + "..." : body;

    const result = await pushNotificationService.sendToTargets(targets, {
      title,
      body: truncatedBody,
      data: {
        type: "new_message",
        conversationId: conversationId || null,
        username: clientUsername || username || null,
        clientName: clientName || null,
        messageText: messageText || null,
        isTest: isTest || false,
      },
    });

    if (Array.isArray(result?.goneEndpoints)) {
      for (const endpoint of result.goneEndpoints) {
        await this.removeWebPushSubscription(endpoint);
      }
    }
  }

  /**
   * Handle client activated
   */
  onClientActivated(username) {
    // Store data
    if (!this.storedClientActivations.includes(username)) {
      this.storedClientActivations.push(username);
      if (this.storedClientActivations.length > 100) {
        this.storedClientActivations.shift();
      }
    }

    // Emit event for local server listeners, but do not broadcast client activation
    // globally to all Expo clients because this can cause selection and refresh loops.
    this.emit("client_activated", username);
  }

  /**
   * Handle new client detected (first-time client with clock icon)
   */
  onNewClientDetected(data) {
    const { clientUsername, clientName, clientData, url, timestamp } = data;
    const usernameKey = String(clientUsername || clientData?.username || "")
      .trim()
      .toLowerCase();
    if (!usernameKey) {
      return;
    }

    const lastAlertAt = this.recentNewClientAlerts.get(usernameKey) || 0;
    const NEW_CLIENT_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
    if (Date.now() - lastAlertAt < NEW_CLIENT_ALERT_COOLDOWN_MS) {
      return;
    }
    this.recentNewClientAlerts.set(usernameKey, Date.now());

    // Prepare client information
    const newClientInfo = {
      username: clientUsername,
      name: clientName || clientUsername,
      conversationId: clientUsername,
      url: url || null,
      timestamp: timestamp || new Date().toISOString(),
      isNewClient: true,
    };

    // Include additional client data if available
    if (clientData) {
      if (clientData.name) newClientInfo.name = clientData.name;
      if (clientData.avatarUrl) {
        newClientInfo.avatarUrl = clientData.avatarUrl;
        newClientInfo.avatar_url = clientData.avatarUrl;
      }
      if (clientData.username) newClientInfo.username = clientData.username;
    }

    // Emit event
    this.emit("new_client_detected", newClientInfo);

    this.saveClientDataToMongo(newClientInfo).catch((err) => {});

    // Broadcast to Expo clients via WebSocket (if app is running)
    this.broadcastToExpoClients({
      type: "new_client_detected",
      data: newClientInfo,
    });

    // Send push notifications to all registered tokens (works even when app is closed)
    this.sendPushNotificationForNewClient(newClientInfo).catch((error) => {});
  }

  getRegisteredPushTokens() {
    return Array.from(this.pushTokens.keys());
  }

  /**
   * Send push notification for new client
   * This works even when the app is completely closed
   */
  async sendPushNotificationForNewClient(clientInfo) {
    const { username, name } = clientInfo;

    const targets = await this.getAllPushTargets();
    if (targets.length === 0) {
      return;
    }

    const title = `New Client: ${name || username}`;
    const body = `You have a new client message from ${name || username}!`;

    const result = await pushNotificationService.sendToTargets(targets, {
      title,
      body,
      data: {
        type: "new_client",
        username: username,
        clientName: name || username,
        conversationId: username,
        isNewClient: true,
      },
    });

    if (Array.isArray(result?.goneEndpoints)) {
      for (const endpoint of result.goneEndpoints) {
        await this.removeWebPushSubscription(endpoint);
      }
    }
  }

  /**
   * Broadcast current seller online status to Expo clients.
   */
  broadcastSellerOnlineStatus() {
    this.broadcastToExpoClients({
      type: "seller_profiles",
      data: this.getSellerProfilesWithOnline(),
    });

    if (this.sellerProfile) {
      const online = this.getOnlineUsernames();
      this.broadcastToExpoClients({
        type: "seller_profile",
        data: {
          ...this.sellerProfile,
          online: online.has(this.sellerProfile.username),
        },
      });
    }
  }

  /**
   * Remove a WebSocket from tracking maps only if it is still the active
   * socket for that session. Prevents a stale reconnect race where an old
   * socket's close handler deletes a newer connection that reused the same
   * session_id (common with Chrome MV3 service worker restarts).
   */
  cleanupWebSocketSession(ws, { broadcastOnline = true } = {}) {
    if (!ws) {
      return;
    }

    const sessionId = ws._sessionId;
    const wasBrowserOnline =
      !!sessionId && this.browserProfileBySession.get(sessionId) != null;

    this.clientSessions.delete(ws);

    if (sessionId && this.connectedClients.get(sessionId) === ws) {
      this.connectedClients.delete(sessionId);
      this.clientTypes.delete(sessionId);
      if (this.browserProfileBySession.has(sessionId)) {
        this.browserProfileBySession.delete(sessionId);
      }
      this.sessionPushTokens.delete(sessionId);

      if (broadcastOnline && wasBrowserOnline) {
        this.broadcastSellerOnlineStatus();
      }

      this.broadcastExpoPresenceToBrowsers();
    }
  }

  /**
   * True when at least one Expo app is connected and therefore owns auto-reply
   * timing. The extension uses this to stay out of the way until Expo is gone.
   */
  isExpoConnected() {
    for (const sessionId of this.connectedClients.keys()) {
      if (this.clientTypes.get(sessionId) === "expo") {
        return true;
      }
    }
    return false;
  }

  broadcastExpoPresenceToBrowsers() {
    const expoConnected = this.isExpoConnected();
    const payload = JSON.stringify({
      type: "commands",
      commands: [{ type: "set_expo_presence", expoConnected }],
    });

    for (const [sessionId, browserWs] of this.connectedClients.entries()) {
      if (this.clientTypes.get(sessionId) !== "browser") continue;
      try {
        browserWs.send(payload);
      } catch (_error) {
        // Socket is closing; cleanup will handle it.
      }
    }
  }

  /**
   * Replace an existing session socket with a newer one.
   * Caller must register `newWs` in connectedClients BEFORE closing the old socket.
   */
  supersedeSessionSocket(existingWs, newWs) {
    if (!existingWs || existingWs === newWs) {
      return;
    }

    existingWs._superseded = true;
    this.clientSessions.delete(existingWs);

    try {
      existingWs.close(4000, "Replaced by new connection");
    } catch (_) {
      // Ignore close errors on dead sockets
    }
  }

  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws, req) {
    // Store session info on websocket object
    ws._sessionId = null;
    ws._clientType = "browser";
    ws._isAlive = true;
    ws._superseded = false;

    ws.on("pong", () => {
      ws._isAlive = true;
    });

    // Set up message handler
    ws.on("message", async (message) => {
      ws._isAlive = true;
      try {
        // Log raw incoming message for diagnostics (trim long payloads)
        try {
          const raw = String(message).slice(0, 2000);
          console.log("[MessageServer] Raw WS message received", {
            session: ws._sessionId,
            clientType: ws._clientType,
            rawPreview: raw,
          });
        } catch (_) {}

        const data = JSON.parse(message.toString());

        await this.handleMessage(data, ws);
      } catch (error) {
        if (error instanceof SyntaxError) {
        } else {
        }
      }
    });

    ws.on("close", () => {
      const sessionId = ws._sessionId;

      this.cleanupWebSocketSession(ws, { broadcastOnline: !ws._superseded });
    });

    ws.on("error", (error) => {});
  }

  /**
   * Handle incoming message from WebSocket client
   */
  async handleMessage(data, ws) {
    const msgType = data.type;
    const sessionId = ws._sessionId;

    // Log high-level message receipt
    try {
      console.log("[MessageServer] handleMessage", {
        type: msgType,
        sessionId,
        clientType: ws._clientType,
      });
    } catch (_) {}

    if (!sessionId && msgType !== "connect") {
      return;
    }

    if (msgType === "connect") {
      const newSessionId = data.session_id || generateSessionId(this);
      const clientType = data.client_type || "browser";

      const authToken = data.token || data.authToken || null;
      if (authToken) {
        const user = await this.getUserByToken(authToken);
        if (user) {
          ws._user = user;
          ws._userId = this.getUserIdentifier(user);
          ws._userRole = this.normalizeRole(user.role, user);
        }
      }

      // Store on websocket object
      ws._sessionId = newSessionId;
      ws._clientType = clientType;
      ws._isAlive = true;

      // Register the new socket first, then close any prior socket for this
      // session. This prevents the old close handler from wiping the new entry.
      const existingWs = this.connectedClients.get(newSessionId);
      this.connectedClients.set(newSessionId, ws);
      this.clientSessions.set(ws, newSessionId);
      this.clientTypes.set(newSessionId, clientType);
      this.supersedeSessionSocket(existingWs, ws);

      this.broadcastExpoPresenceToBrowsers();

      // Send connection confirmation
      try {
        const confirmMessage = JSON.stringify({
          type: "connected",
          session_id: newSessionId,
          status: "ok",
        });
        ws.send(confirmMessage);
      } catch (error) {}

      // Send stored data based on client type
      if (clientType === "expo") {
        await this.sendStoredDataToExpo(ws);
      } else if (clientType === "desktop") {
        await this.sendPendingCommands(newSessionId, ws);
        if (this.sellerProfile) {
          const online = this.getOnlineUsernames();
          ws.send(
            JSON.stringify({
              type: "seller_profile",
              data: {
                ...this.sellerProfile,
                online: online.has(this.sellerProfile.username),
              },
            }),
          );
        }
        if (this.sellerProfiles.size > 0) {
          ws.send(
            JSON.stringify({
              type: "seller_profiles",
              data: this.getSellerProfilesWithOnline(),
            }),
          );
        }
      } else {
        // Browser extension
        await this.sendPendingCommands(newSessionId, ws);
        if (this.sellerProfile?.username) {
          this.browserProfileBySession.set(
            newSessionId,
            this.sellerProfile.username,
          );
        }
        if (this.sellerProfile) {
          const online = this.getOnlineUsernames();
          ws.send(
            JSON.stringify({
              type: "seller_profile",
              data: {
                ...this.sellerProfile,
                online: online.has(this.sellerProfile.username),
              },
            }),
          );
        }
        if (this.sellerProfiles.size > 0) {
          ws.send(
            JSON.stringify({
              type: "seller_profiles",
              data: this.getSellerProfilesWithOnline(),
            }),
          );
        }
        this.broadcastToExpoClients({
          type: "seller_profiles",
          data: this.getSellerProfilesWithOnline(),
        });
        if (this.sellerProfile) {
          const online = this.getOnlineUsernames();
          this.broadcastToExpoClients({
            type: "seller_profile",
            data: {
              ...this.sellerProfile,
              online: online.has(this.sellerProfile.username),
            },
          });
        }
      }
    } else if (msgType === "send_message_result") {
      // Relay the extension's real send outcome so Expo can retry instead of
      // assuming a socket write meant the message reached Fiverr.
      const result = data.data || {};

      this.broadcastToExpoClients({
        type: "send_message_result",
        data: result,
      });
    } else if (msgType === "message_data") {
      const messageData = data.data || data;

      this.onMessageReceived(messageData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Data received",
        }),
      );
    } else if (msgType === "client_data") {
      const clientData = data.data || data;

      this.onClientDataReceived(clientData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Client data received",
        }),
      );
    } else if (msgType === "client_list_data") {
      const clientListData = data.data || data;

      this.onClientListReceived(clientListData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Client list data received",
        }),
      );
    } else if (msgType === "new_message_detected") {
      const newMessageData = data.data || data;

      this.onNewMessageDetected(newMessageData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "New message detection received",
        }),
      );
    } else if (msgType === "client_activated") {
      const clientData = data.data || data;
      const username =
        typeof clientData === "object" ? clientData.username : data.username;

      if (username) {
        this.onClientActivated(username);
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Client activated notification received",
        }),
      );
    } else if (msgType === "new_client_detected") {
      const newClientData = data.data || data;

      this.onNewClientDetected(newClientData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "New client detection received",
        }),
      );
    } else if (msgType === "seller_profile") {
      const profileName = (data.profileName || data.profile_name || "").trim();
      let username = (data.username || "").trim();
      const avatarUrl = data.avatarUrl || data.avatar_url || null;

      if (profileName || username) {
        if (!username) {
          username = profileName || `profile_${this.sellerProfiles.size}`;
        }

        const entry = {
          profileName: profileName,
          username: username,
          avatarUrl: avatarUrl,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        };

        this.sellerProfiles.set(username, entry);
        this.sellerProfile = entry;
        await this.saveSellerProfiles();

        // Track browser session as online
        const currentSessionId = ws._sessionId;
        if (
          currentSessionId &&
          this.clientTypes.get(currentSessionId) === "browser"
        ) {
          this.browserProfileBySession.set(currentSessionId, username);
        }

        const online = this.getOnlineUsernames();
        const currentWithOnline = {
          ...this.sellerProfile,
          online: online.has(username),
        };
        const profilesWithOnline = this.getSellerProfilesWithOnline();

        // Broadcast to Expo/desktop
        this.broadcastToExpoClients({
          type: "seller_profile",
          data: currentWithOnline,
        });
        this.broadcastToExpoClients({
          type: "seller_profiles",
          data: profilesWithOnline,
        });

        // Send to desktop clients
        for (const [sid, desktopWs] of this.connectedClients.entries()) {
          if (this.clientTypes.get(sid) === "desktop") {
            try {
              desktopWs.send(
                JSON.stringify({
                  type: "seller_profile",
                  data: currentWithOnline,
                }),
              );
              desktopWs.send(
                JSON.stringify({
                  type: "seller_profiles",
                  data: profilesWithOnline,
                }),
              );
            } catch (error) {}
          }
        }
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Seller profile received and saved",
        }),
      );
    } else if (msgType === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (msgType === "updateActivatedTabUrl") {
      this.currentActivatedFiverrUrl = data.url || null;

      this.broadcastToExpoClients({
        type: "updateActivatedTabUrl",
        data: {
          url: this.currentActivatedFiverrUrl,
        },
      });

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Activated Fiverr tab URL updated",
        }),
      );
    } else if (msgType === "request_all_data") {
      await this.sendStoredDataToExpo(ws);
    } else if (msgType === "request_client_list") {
      const currentUser = ws._user || null;

      await this.ensureClientListHydratedFromMongo();

      if (this.storedClientList) {
        const filteredClientList = await this.filterClientListForUser(
          currentUser,
          this.storedClientList,
        );
        ws.send(
          JSON.stringify({
            type: "client_list_data",
            data: filteredClientList,
          }),
        );
      } else {
        this.pendingClientListTrigger = true;
        this.triggerClientListExtraction();
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "pending",
            message: "Client list pending extension extract",
          }),
        );
      }
    } else if (msgType === "request_messages") {
      const target = data.conversationId || data.username || null;
      const currentUser = ws._user || null;
      const isAdmin =
        currentUser &&
        this.normalizeRole(currentUser.role, currentUser) === "admin";

      const persisted = await this.loadMessagesFromMongo();
      const inMemoryPayloads =
        this.storedMessageDataByConversation.size > 0
          ? Array.from(this.storedMessageDataByConversation.values())
          : this.storedMessageData
            ? [this.storedMessageData]
            : [];
      const payloads = this.mergeMessagePayloadSources(
        persisted,
        inMemoryPayloads,
      );
      const filteredPayloads = await this.filterMessagePayloadsForUser(
        currentUser,
        payloads,
        target,
      );

      for (const pl of filteredPayloads || []) {
        if (pl) {
          ws.send(JSON.stringify({ type: "message_data", data: pl }));
        }
      }

      if (target && data.triggerExtraction === true) {
        this.scheduleBrowserMessageExtraction(target, [5000, 12000, 25000]);
      }
    } else if (msgType === "request_client_data") {
      const clientKey = data.username || data.conversationId;
      const currentUser = ws._user || null;
      const isAdmin =
        currentUser &&
        this.normalizeRole(currentUser.role, currentUser) === "admin";
      const canAccess =
        Boolean(currentUser) &&
        (isAdmin || (await this.canUserAccessClient(currentUser, clientKey)));

      if (clientKey && this.storedClientData.has(clientKey) && canAccess) {
        const clientPayload = this.storedClientData.get(clientKey);
        const assignedIds = await this.getAssignedClientIds(currentUser);
        if (
          isAdmin ||
          this.payloadMatchesAssignedIds(clientPayload, assignedIds)
        ) {
          ws.send(
            JSON.stringify({
              type: "client_data",
              data: clientPayload,
            }),
          );
        }
      }
    } else if (msgType === "trigger") {
      const action = data.action;
      const targetConversationId = data.conversationId || data.username || null;

      const command = {
        type: "trigger",
        action: action,
      };

      // Preserve the target identifier so the extension activates and extracts
      // the correct conversation instead of whatever tab/conversation is currently open.
      if (data.conversationId || data.username) {
        command.conversationId = data.conversationId || data.username;
        command.username = data.username || data.conversationId;
      }

      if (data.scrollToLoadAll === true) {
        command.scrollToLoadAll = true;
      }

      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: "commands",
          commands: [command],
        });

        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
          } catch (error) {}
        }
      } else if (action === "extract_client_list") {
        this.pendingClientListTrigger = true;
      } else if (action === "extract_messages") {
        this.pendingTrigger = true;
      } else if (action === "extract_client_data") {
        this.pendingClientTrigger = true;
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: `Trigger command sent: ${action}`,
        }),
      );
    } else if (msgType === "click_client" || msgType === "clickFirstClient") {
      const rawUser = data.username || data.conversationId || "";
      const username = String(rawUser)
        .trim()
        .replace(/^@/, "")
        .replace(
          /^(user|client|conversation|conv|seller|profile|inbox|chat)[_:-]?/i,
          "",
        );
      const useFirstClient =
        data.useFirstClient || msgType === "clickFirstClient";
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        type: msgType,
        username: username || null,
        useFirstClient,
        source: "server-click-handler",
      };

      fs.appendFileSync(
        path.join(__dirname, "click_events.log"),
        `${JSON.stringify(logEntry)}\n`,
        "utf8",
      );

      let command;
      if (useFirstClient) {
        command = { type: "clickFirstClient" };
      } else {
        if (!username) {
          ws.send(
            JSON.stringify({
              type: "ack",
              status: "error",
              message: "Username is required for click_client command",
            }),
          );
          return;
        }
        command = {
          type: "click_client",
          username: username,
          useFirstClient: false,
        };
      }

      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: "commands",
          commands: [command],
        });

        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
          } catch (error) {}
        }

        if (username && !useFirstClient) {
          this.scheduleBrowserMessageExtraction(username);
        }

        ws.send(
          JSON.stringify({
            type: "ack",
            status: "success",
            message: `Click client command sent: ${username || "first client"}`,
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message:
              "Browser extension is not connected. Open Fiverr in Chrome, click the extension icon, and activate the Fiverr tab.",
          }),
        );
      }
      return;
    } else if (msgType === "auto_reply_settings") {
      const settings = data.data || {};
      const command = {
        type: "set_auto_reply_config",
        config: {
          enabled: settings.enabled === true,
          delayMinutes: Number(settings.delayMinutes) || 30,
          apiKey: String(settings.apiKey || ""),
          model: String(settings.model || "gemini-3.5-flash"),
          userProfile: settings.userProfile || null,
        },
      };
      this.autoReplyConfig = command.config;

      // Settings are intentionally relayed only to browser extensions and are
      // not persisted or logged by the server.
      let forwarded = 0;
      for (const [sessionId, browserWs] of this.connectedClients.entries()) {
        if (this.clientTypes.get(sessionId) !== "browser") continue;
        try {
          browserWs.send(
            JSON.stringify({ type: "commands", commands: [command] }),
          );
          forwarded += 1;
        } catch (error) {}
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: forwarded > 0 ? "success" : "warning",
          message:
            forwarded > 0
              ? "Auto-reply settings synced to extension"
              : "No browser extension connected for auto-reply settings",
        }),
      );
      return;
    } else if (msgType === "tab_reload_settings") {
      const settings = data.data || {};
      const command = {
        type: "set_tab_reload_config",
        config: {
          global: settings.global || {},
          profiles: settings.profiles || {},
        },
      };
      this.tabReloadConfig = command.config;

      let forwarded = 0;
      for (const [sessionId, browserWs] of this.connectedClients.entries()) {
        if (this.clientTypes.get(sessionId) !== "browser") continue;
        try {
          browserWs.send(
            JSON.stringify({ type: "commands", commands: [command] }),
          );
          forwarded += 1;
        } catch (error) {}
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: forwarded > 0 ? "success" : "warning",
          message:
            forwarded > 0
              ? "Tab reload settings synced to extension"
              : "No browser extension connected for tab reload settings",
        }),
      );
      return;
    } else if (msgType === "expo_app_activity") {
      const activity = data.data || {};
      this.expoAppActivity = {
        active: activity.active === true,
        selectedProfileUsername: String(activity.selectedProfileUsername || "")
          .trim()
          .toLowerCase(),
        at: Number(activity.at) || Date.now(),
      };

      const command = {
        type: "set_expo_app_activity",
        active: this.expoAppActivity.active,
        selectedProfileUsername: this.expoAppActivity.selectedProfileUsername,
        at: this.expoAppActivity.at,
      };

      for (const [sessionId, browserWs] of this.connectedClients.entries()) {
        if (this.clientTypes.get(sessionId) !== "browser") continue;
        try {
          browserWs.send(
            JSON.stringify({ type: "commands", commands: [command] }),
          );
        } catch (error) {}
      }
      return;
    } else if (msgType === "send_message") {
      const rawMessageText =
        data.message ?? data.text ?? data.body ?? data.content ?? "";
      const messageText =
        typeof rawMessageText === "string"
          ? rawMessageText.trim()
          : String(rawMessageText || "").trim();
      const conversationId = data.conversationId;
      const username =
        data.username || data.clientUsername || data.client || null;
      const targetKey = conversationId || username || null;

      console.log("[MessageServer] received send_message", {
        sessionId: ws._sessionId || null,
        conversationId: conversationId || username || null,
        username: username || null,
        messageLength: messageText.length,
        messagePreview: messageText.slice(0, 240),
      });

      if (!targetKey) {
        console.warn(
          "[MessageServer] send_message missing conversationId/username",
          {
            incoming: data,
            sessionId: ws._sessionId || null,
            user: ws._user || null,
          },
        );
      }

      if (!messageText || !messageText.trim()) {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "Message text is required",
          }),
        );
        return;
      }

      const currentUser = ws._user || null;
      if (
        currentUser &&
        this.normalizeRole(currentUser.role, currentUser) !== "admin"
      ) {
        const canAccess = await this.canUserAccessClient(
          currentUser,
          targetKey,
        );
        if (!canAccess) {
          ws.send(
            JSON.stringify({
              type: "ack",
              status: "error",
              message: "You are not authorized to message this client",
            }),
          );
          return;
        }
      }

      const targetIdentifier = conversationId || username || null;

      // First, send an activate_inbox command to ensure the receiving client's inbox is active
      const activateCommand = {
        type: "activate_inbox",
        conversationId: targetIdentifier,
        username: targetIdentifier,
      };

      const command = {
        type: "send_message",
        message: messageText,
        text: messageText,
        body: messageText,
        conversationId: conversationId || username || null,
        username: username || conversationId || null,
        autoReply: data.autoReply === true,
      };

      console.log("[MessageServer] forwarding send_message to extension", {
        conversationId: command.conversationId,
        username: command.username,
        messageLength: command.message.length,
        messagePreview: command.message.slice(0, 240),
      });

      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      let forwardedToBrowser = false;

      if (browserClients.length > 0) {
        // Send activate_inbox command first, then send_message command
        const activateMessage = JSON.stringify({
          type: "commands",
          commands: [activateCommand],
        });

        const sendMessage = JSON.stringify({
          type: "commands",
          commands: [command],
        });

        // Forward to exactly one browser extension to avoid duplicate Fiverr sends
        // when multiple extension sockets are connected.
        const [, browserWs] = browserClients[0];
        try {
          // Send activate command first
          browserWs.send(activateMessage);
          // Small delay to ensure inbox is activated before sending message
          setTimeout(() => {
            try {
              browserWs.send(sendMessage);
            } catch (sendError) {
              console.error(
                "[MessageServer] Error sending message after activation",
                sendError,
              );
            }
          }, 100);
          forwardedToBrowser = true;
        } catch (error) {
          // Fall back to other browser clients if the first one failed
          for (let i = 1; i < browserClients.length; i += 1) {
            try {
              const fallbackWs = browserClients[i][1];
              fallbackWs.send(activateMessage);
              setTimeout(() => {
                try {
                  fallbackWs.send(sendMessage);
                } catch (sendError) {}
              }, 100);
              forwardedToBrowser = true;
              break;
            } catch (fallbackError) {}
          }
        }
      } else {
        this.pendingSendMessage = command;
      }

      if (!forwardedToBrowser) {
        // Say so now rather than leaving the sender waiting for a confirmation
        // that no extension will ever produce.
        this.broadcastToExpoClients({
          type: "send_message_result",
          data: {
            conversationId: command.conversationId,
            autoReply: command.autoReply,
            success: false,
            error:
              "Browser extension is not connected to the server, so nothing could be typed into Fiverr. Open Fiverr in Chrome and activate the extension.",
          },
        });
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: forwardedToBrowser ? "success" : "error",
          message: forwardedToBrowser
            ? "Send message command sent to browser extension"
            : "Browser extension is not connected; message was queued",
        }),
      );
    } else if (msgType === "fetch_client_details") {
      const username = data.username;
      if (!username) {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "Username is required for fetch_client_details",
          }),
        );
        return;
      }

      if (this.connectedClients.size === 0) {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message:
              "Browser extension is not connected. Please open a Fiverr tab and ensure the extension is enabled.",
          }),
        );
        return;
      }

      try {
        const profileUrl = `https://www.fiverr.com/${username}`;

        if (!this.navigateToUrl(profileUrl)) {
          ws.send(
            JSON.stringify({
              type: "ack",
              status: "error",
              message: "Failed to send navigate command to browser extension",
            }),
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "ack",
            status: "success",
            message: `Navigating to ${username}'s profile. Extraction will start shortly...`,
          }),
        );

        // Wait longer for page to fully load (8 seconds) then trigger extraction
        // The content script will also wait for page load, so this gives enough time
        setTimeout(() => {
          this.triggerClientExtraction();
        }, 8000);
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: `Error fetching client details: ${error.message}`,
          }),
        );
      }
    } else if (msgType === "command_status") {
      const commandType = data.commandType;
      const status = data.status || "unknown";
      const message = data.message || "";
      const error = data.error;

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Command status received",
        }),
      );
    } else if (msgType === "navigate") {
      const url = data.url;

      if (!url) {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "URL is required for navigate command",
          }),
        );
        return;
      }

      const command = {
        type: "navigate",
        url: url,
      };

      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: "commands",
          commands: [command],
        });

        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
          } catch (error) {}
        }
      } else {
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: `Navigate command sent: ${url}`,
        }),
      );
    } else if (msgType === "reload") {
      const command = {
        type: "reload",
      };

      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: "commands",
          commands: [command],
        });

        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
          } catch (error) {}
        }
      } else {
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Reload command sent to browser extension",
        }),
      );
    } else if (msgType === "register_push_token") {
      const pushToken = data.pushToken || data.push_token;
      if (pushToken && sessionId) {
        const userId = ws._user?.id || ws._user?._id || null;
        this.pushTokens.set(pushToken, {
          token: pushToken,
          sessionId,
          userId,
          registeredAt: Date.now(),
        });
        this.sessionPushTokens.set(sessionId, pushToken);

        ws.send(
          JSON.stringify({
            type: "ack",
            status: "success",
            message: "Push token registered",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "Invalid push token registration",
          }),
        );
      }
    } else if (msgType === "register_web_push") {
      const subscription = data.subscription || data.pushSubscription;
      const endpoint = subscription?.endpoint;
      if (endpoint && subscription?.keys?.p256dh && subscription?.keys?.auth) {
        const userId = ws._user?.id || ws._user?._id || null;
        await this.persistWebPushSubscription({
          type: "web",
          endpoint,
          subscription: {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime || null,
            keys: {
              p256dh: subscription.keys.p256dh,
              auth: subscription.keys.auth,
            },
          },
          userId,
          sessionId,
          registeredAt: Date.now(),
        });

        ws.send(
          JSON.stringify({
            type: "ack",
            status: "success",
            message: "Web push subscription registered",
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "Invalid web push subscription",
          }),
        );
      }
    } else if (msgType === "test_notification") {
      // Handle test notification from browser extension
      const testData = data.data || data;
      const testPayload = {
        clientName: testData.clientName || "Test Client",
        messageText: testData.messageText || "This is a test notification!",
        conversationId: testData.conversationId || "test_" + Date.now(),
        username: testData.username || "testuser",
        clientUsername: testData.username || "testuser",
        isTest: true,
      };

      // Broadcast test notification to Expo clients
      this.broadcastToExpoClients({
        type: "new_message_detected",
        data: testPayload,
      });

      // Also deliver remote push (native + web PWA)
      this.sendPushNotificationForMessage(testPayload).catch(() => {});

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Test notification sent",
        }),
      );
    } else {
    }
  }

  /**
   * Send stored data to Expo client
   */
  async sendStoredDataToExpo(ws) {
    // Snapshot data
    const currentUser = ws._user || null;
    const canShowAll =
      currentUser &&
      this.normalizeRole(currentUser.role, currentUser) === "admin";

    // Hydrate + send the client list BEFORE the heavy Mongo message scan so the
    // web app can render the sidebar in one RTT after connect.
    await this.ensureClientListHydratedFromMongo();

    let assignedIds = [];
    if (!canShowAll) {
      assignedIds = await this.getAssignedClientIds(currentUser);
    }

    let snapshotClientList = null;
    if (this.storedClientList) {
      snapshotClientList = await this.filterClientListForUser(
        currentUser,
        JSON.parse(JSON.stringify(this.storedClientList)),
      );
    }

    const snapshotClientData = new Map();
    if (canShowAll) {
      for (const [key, value] of this.storedClientData.entries()) {
        snapshotClientData.set(key, JSON.parse(JSON.stringify(value)));
      }
    } else {
      for (const [key, value] of this.storedClientData.entries()) {
        if (this.payloadMatchesAssignedIds(value, assignedIds)) {
          snapshotClientData.set(key, JSON.parse(JSON.stringify(value)));
        }
      }
    }

    const snapshotSellerProfile = this.sellerProfile
      ? JSON.parse(JSON.stringify(this.sellerProfile))
      : null;
    const online = this.getOnlineUsernames();
    const snapshotSellerProfiles = Array.from(this.sellerProfiles.values()).map(
      (p) => ({
        ...JSON.parse(JSON.stringify(p)),
        online: online.has(p.username),
      }),
    );

    try {
      if (snapshotClientList) {
        ws.send(
          JSON.stringify({
            type: "client_list_data",
            data: snapshotClientList,
          }),
        );
      }

      if (snapshotSellerProfile) {
        const currentWithOnline = {
          ...snapshotSellerProfile,
          online: online.has(snapshotSellerProfile.username),
        };
        ws.send(
          JSON.stringify({ type: "seller_profile", data: currentWithOnline }),
        );
      }

      if (snapshotSellerProfiles.length > 0) {
        ws.send(
          JSON.stringify({
            type: "seller_profiles",
            data: snapshotSellerProfiles,
          }),
        );
      }

      for (const [, clientData] of snapshotClientData.entries()) {
        ws.send(JSON.stringify({ type: "client_data", data: clientData }));
      }

      // Messages are slower; send after clients so the UI is already usable.
      const snapshotMessagesFromMemory =
        this.storedMessageDataByConversation.size > 0
          ? Array.from(this.storedMessageDataByConversation.values()).map(
              (payload) => JSON.parse(JSON.stringify(payload)),
            )
          : this.storedMessageData && canShowAll
            ? [JSON.parse(JSON.stringify(this.storedMessageData))]
            : [];
      const persistedMessagePayloads = await this.loadMessagesFromMongo();
      let messagePayloads = this.mergeMessagePayloadSources(
        persistedMessagePayloads,
        snapshotMessagesFromMemory,
      );

      if (!canShowAll) {
        messagePayloads = await this.filterMessagePayloadsForUser(
          currentUser,
          messagePayloads,
        );
      }

      for (const messagePayload of messagePayloads) {
        ws.send(JSON.stringify({ type: "message_data", data: messagePayload }));
      }

      let snapshotNewMessages = this.storedNewMessages.slice(-10);
      let snapshotActivations = this.storedClientActivations.slice(-10);
      if (!canShowAll) {
        snapshotNewMessages = snapshotNewMessages.filter((newMsg) =>
          this.payloadMatchesAssignedIds(newMsg, assignedIds),
        );
        snapshotActivations = snapshotActivations.filter((username) =>
          this.payloadMatchesAssignedIds({ username }, assignedIds),
        );
      }

      for (const newMsg of snapshotNewMessages) {
        ws.send(
          JSON.stringify({
            type: "new_message_detected",
            data: { ...newMsg, historical: true },
          }),
        );
      }

      for (const username of snapshotActivations) {
        ws.send(
          JSON.stringify({ type: "client_activated", data: { username } }),
        );
      }

      if (this.currentActivatedFiverrUrl) {
        ws.send(
          JSON.stringify({
            type: "updateActivatedTabUrl",
            data: {
              url: this.currentActivatedFiverrUrl,
            },
          }),
        );
      }

      ws.send(
        JSON.stringify({
          type: "sync_complete",
          status: "ok",
          message: "All stored data sent",
        }),
      );
    } catch (error) {}
  }

  /**
   * Ask connected browser extensions to extract messages after inbox has time to load.
   */
  scheduleBrowserMessageExtraction(target, delaysMs = [4000, 10000, 20000]) {
    const normalized = String(target || "")
      .trim()
      .replace(/^@/, "")
      .replace(
        /^(user|client|conversation|conv|seller|profile|inbox|chat)[_:-]?/i,
        "",
      )
      .toLowerCase();

    if (!normalized) {
      return;
    }

    const existingTimeouts =
      this.scheduledExtractionByTarget.get(normalized) || [];
    for (const timeoutId of existingTimeouts) {
      clearTimeout(timeoutId);
    }

    const generation =
      (this.extractionGenerationByTarget.get(normalized) || 0) + 1;
    this.extractionGenerationByTarget.set(normalized, generation);
    this.latestExtractionTarget = normalized;

    const sendExtract = () => {
      if (this.extractionGenerationByTarget.get(normalized) !== generation) {
        return;
      }

      const browserClients = Array.from(this.connectedClients.entries()).filter(
        ([sid]) => this.clientTypes.get(sid) === "browser",
      );

      if (browserClients.length === 0) {
        return;
      }

      const payload = JSON.stringify({
        type: "commands",
        commands: [
          {
            type: "trigger",
            action: "extract_messages",
            conversationId: normalized,
            username: normalized,
          },
        ],
      });

      for (const [, browserWs] of browserClients) {
        try {
          browserWs.send(payload);
        } catch (error) {}
      }
    };

    const timeoutIds = delaysMs.map((delay) => setTimeout(sendExtract, delay));
    this.scheduledExtractionByTarget.set(normalized, timeoutIds);
    this.scheduledExtractionTimeouts = Array.from(
      this.scheduledExtractionByTarget.values(),
    ).flat();
  }

  /**
   * Send pending commands to client
   */
  async sendPendingCommands(sessionId, ws) {
    const commands = [];

    if (this.clientTypes.get(sessionId) === "browser") {
      commands.push({
        type: "set_expo_presence",
        expoConnected: this.isExpoConnected(),
      });
      if (this.autoReplyConfig) {
        commands.push({
          type: "set_auto_reply_config",
          config: this.autoReplyConfig,
        });
      }
      if (this.tabReloadConfig) {
        commands.push({
          type: "set_tab_reload_config",
          config: this.tabReloadConfig,
        });
      }
      if (this.expoAppActivity) {
        commands.push({
          type: "set_expo_app_activity",
          active: this.expoAppActivity.active === true,
          selectedProfileUsername:
            this.expoAppActivity.selectedProfileUsername || "",
          at: Number(this.expoAppActivity.at) || Date.now(),
        });
      }
    }

    if (this.pendingTrigger) {
      commands.push({
        type: "trigger",
        action: "extract_messages",
      });
      this.pendingTrigger = false;
    }

    if (this.pendingClientTrigger) {
      commands.push({
        type: "trigger",
        action: "extract_client_data",
      });
      this.pendingClientTrigger = false;
    }

    if (this.pendingClientListTrigger) {
      commands.push({
        type: "trigger",
        action: "extract_client_list",
      });
      this.pendingClientListTrigger = false;
    }

    if (this.pendingSendMessage) {
      const pending = this.pendingSendMessage;
      this.pendingSendMessage = null;
      const pendingCommand =
        typeof pending === "string"
          ? { type: "send_message", message: pending }
          : { ...pending, type: "send_message" };

      // Replaying without a recipient would deliver to whichever conversation
      // happens to be open in the browser, so drop it instead.
      if (pendingCommand.conversationId || pendingCommand.username) {
        commands.push(pendingCommand);
      } else {
      }
    }

    if (this.pendingClickCommands.length > 0) {
      commands.push(...this.pendingClickCommands);
      this.pendingClickCommands = [];
    }

    const sessionCommands = this.pendingCommands.get(sessionId) || [];
    this.pendingCommands.delete(sessionId);
    commands.push(...sessionCommands);

    if (commands.length > 0) {
      ws.send(
        JSON.stringify({
          type: "commands",
          commands: commands,
        }),
      );
    }
  }

  /**
   * Broadcast to Expo clients
   */
  async broadcastToExpoClients(message) {
    if (this.connectedClients.size === 0) {
      return;
    }

    const disconnected = [];

    for (const [sessionId, ws] of this.connectedClients.entries()) {
      if (this.clientTypes.get(sessionId) !== "expo") {
        continue;
      }

      const user = ws._user || null;
      const canShowAll =
        user && this.normalizeRole(user.role, user) === "admin";
      let messageToSend = message;

      if (!canShowAll) {
        const assignedIds = await this.getAssignedClientIds(user);

        if (message.type === "client_list_data") {
          const filteredList = await this.filterClientListForUser(
            user,
            JSON.parse(JSON.stringify(message.data || {})),
          );
          messageToSend = {
            type: "client_list_data",
            data: filteredList,
          };
        } else if (message.type === "message_data") {
          const filteredPayloads = await this.filterMessagePayloadsForUser(
            user,
            [message.data || {}],
          );
          if (filteredPayloads.length === 0) {
            continue;
          }
          messageToSend = {
            type: "message_data",
            data: filteredPayloads[0],
          };
        } else if (message.type === "client_activated") {
          // Do not broadcast client activated events globally to Expo clients.
          continue;
        } else if (
          message.type === "client_data" ||
          message.type === "new_message_detected"
        ) {
          if (
            !this.payloadMatchesAssignedIds(message.data || {}, assignedIds)
          ) {
            continue;
          }
        }
      }

      try {
        ws.send(JSON.stringify(messageToSend));
      } catch (error) {
        disconnected.push(sessionId);
      }
    }

    // Clean up disconnected clients
    for (const sessionId of disconnected) {
      const ws = this.connectedClients.get(sessionId);
      if (ws) {
        this.cleanupWebSocketSession(ws, { broadcastOnline: false });
      } else {
        this.connectedClients.delete(sessionId);
        this.clientTypes.delete(sessionId);
        this.sessionPushTokens.delete(sessionId);
        this.browserProfileBySession.delete(sessionId);
      }
    }
  }

  /**
   * Broadcast command to all clients
   */
  async broadcastCommand(command) {
    if (this.connectedClients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: "commands",
      commands: [command],
    });

    const disconnected = [];
    for (const [sessionId, ws] of this.connectedClients.entries()) {
      try {
        ws.send(message);
      } catch (error) {
        disconnected.push(sessionId);
      }
    }

    // Clean up disconnected clients
    for (const sessionId of disconnected) {
      const ws = this.connectedClients.get(sessionId);
      if (ws) {
        this.cleanupWebSocketSession(ws);
      } else {
        this.connectedClients.delete(sessionId);
        this.clientTypes.delete(sessionId);
        this.browserProfileBySession.delete(sessionId);
      }
    }
  }

  /**
   * Create HTTP server for health checks
   * Note: WebSocket upgrade requests are handled automatically by WebSocketServer
   */
  createHttpServer() {
    return http.createServer((req, res) => {
      // Check if this is a WebSocket upgrade request
      // If so, let the WebSocketServer handle it (it will intercept before this handler)
      const upgrade = req.headers.upgrade;
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        // WebSocketServer will handle this, but we can log it

        // Don't respond here - let WebSocketServer handle it
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS, HEAD",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With",
      );
      res.setHeader("Access-Control-Max-Age", "86400");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (pathname === "/push/vapid-public-key" && req.method === "GET") {
        const publicKey = pushNotificationService.getVapidPublicKey();
        if (!publicKey) {
          const body = JSON.stringify({
            error:
              "VAPID keys are not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.",
          });
          res.writeHead(503, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        const body = JSON.stringify({ publicKey });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      // Health check endpoints
      if (
        pathname === "/" ||
        pathname === "/health" ||
        pathname === "/healthz"
      ) {
        const isRender = process.env.RENDER === "true";
        let wsUrl;

        if (isRender) {
          const renderServiceUrl =
            process.env.RENDER_EXTERNAL_URL ||
            process.env.RENDER_SERVICE_URL ||
            "https://fiverr-agent-03vs.onrender.com";
          wsUrl = renderServiceUrl
            .replace("https://", "wss://")
            .replace("http://", "ws://")
            .replace(/\/$/, "");
        } else {
          wsUrl = `ws://127.0.0.1:${this.port}`;
        }

        const body = JSON.stringify({
          status: "ok",
          message: "MessageServer is running",
          ws: wsUrl,
        });

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (pathname === "/auth/register" && req.method === "POST") {
        (async () => {
          try {
            const body = await this.parseJsonBody(req);
            await this.handleRegister(req, res, body);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/auth/login" && req.method === "POST") {
        (async () => {
          try {
            const body = await this.parseJsonBody(req);
            await this.handleLogin(req, res, body);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/auth/me" && req.method === "GET") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleMe(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/auth/logout" && req.method === "POST") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleLogout(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/me/assignments" && req.method === "GET") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleMyAssignments(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/admin/clients") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleAdminClients(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/clients") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleClients(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname.startsWith("/admin/clients/")) {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            const clientId = pathname.split("/").filter(Boolean).pop();
            await this.handleAdminClientById(
              req,
              res,
              token,
              decodeURIComponent(clientId),
            );
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/admin/messages") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleAdminMessages(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname.startsWith("/admin/messages/")) {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            const messageId = pathname.split("/").filter(Boolean).pop();
            await this.handleAdminMessageById(
              req,
              res,
              token,
              decodeURIComponent(messageId),
            );
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/admin/users") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleAdminUsers(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/admin/assignments") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleAdminAssignments(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/activities") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleUserActivities(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      if (pathname === "/admin/activities") {
        (async () => {
          try {
            const authHeader = req.headers["authorization"] || "";
            const token = authHeader
              .toString()
              .replace(/^Bearer\s+/i, "")
              .trim();
            await this.handleAdminActivities(req, res, token);
          } catch (error) {
            await this.sendJsonResponse(res, 500, {
              error: "Internal server error",
            });
          }
        })();
        return;
      }

      // 404 for other paths
      res.writeHead(404);
      res.end();
    });
  }

  /**
   * Start the server
   */
  start() {
    if (this.running) {
      return;
    }

    this.running = true;

    // Create HTTP server
    this.httpServer = this.createHttpServer();

    // Create WebSocket server (no path restriction - accepts all WebSocket connections)
    this.wss = new WebSocketServer({
      server: this.httpServer,
      perMessageDeflate: false,
      clientTracking: true,
    });

    this.wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";

      this.handleWebSocketConnection(ws, req);
    });

    this.wss.on("error", (error) => {});

    this.wss.on("headers", (headers, req) => {});

    // Detect zombie sockets left behind when Chrome MV3 service workers die
    // without a clean WebSocket close (common after long idle).
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
    }
    this.heartbeatIntervalId = setInterval(() => {
      if (!this.wss) {
        return;
      }
      this.wss.clients.forEach((ws) => {
        if (ws._superseded) {
          return;
        }
        if (ws._isAlive === false) {
          try {
            ws.terminate();
          } catch (_) {
            // Ignore
          }
          return;
        }
        ws._isAlive = false;
        try {
          ws.ping();
        } catch (_) {
          try {
            ws.terminate();
          } catch (__) {
            // Ignore
          }
        }
      });
    }, 30000);

    // Start listening
    this.httpServer.listen(this.port, "0.0.0.0", () => {});

    this.httpServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
      } else {
      }
      this.running = false;
    });
  }

  /**
   * Stop the server
   */
  stop() {
    if (!this.running && !this.httpServer && !this.wss) {
      return;
    }

    this.running = false;

    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }

    // Close all WebSocket connections
    for (const ws of this.connectedClients.values()) {
      try {
        ws.close();
      } catch (error) {
        // Ignore
      }
    }

    this.connectedClients.clear();
    this.clientSessions.clear();
    this.clientTypes.clear();
    this.browserProfileBySession.clear();

    // Clear pending commands
    this.pendingCommands.clear();
    this.pendingTrigger = false;
    this.pendingClientTrigger = false;
    this.pendingClientListTrigger = false;
    this.pendingSendMessage = null;
    this.pendingClickCommands = [];

    // Close WebSocket server
    if (this.wss) {
      this.wss.close(() => {});
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close(() => {});
      this.httpServer = null;
    }

    // Close MongoDB connection
    if (this.mongooseConnection) {
      this.mongooseConnection.close().catch(() => {});
      this.mongooseConnection = null;
    }

    if (this.mongoClient && typeof this.mongoClient.close === "function") {
      this.mongoClient.close().catch(() => {});
    }

    this.mongoClient = null;
    this.mongoDb = null;
    this.mongoProfilesCollection = null;
    this.mongoUsersCollection = null;
    this.mongoClientsCollection = null;
    this.mongoMessagesCollection = null;
    this.mongoAssignmentsCollection = null;
  }

  /**
   * Check if server is running
   */
  isRunning() {
    return this.running && this.httpServer && this.httpServer.listening;
  }

  /**
   * Trigger message extraction
   */
  triggerExtraction() {
    if (!this.running) {
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_messages",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
    } else {
      this.pendingTrigger = true;
    }

    return true;
  }

  /**
   * Trigger client data extraction
   */
  triggerClientExtraction() {
    if (!this.running) {
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_client_data",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
    } else {
      this.pendingClientTrigger = true;
    }

    return true;
  }

  /**
   * Trigger client list extraction
   */
  triggerClientListExtraction() {
    if (!this.running) {
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_client_list",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
    } else {
      this.pendingClientListTrigger = true;
    }

    return true;
  }

  /**
   * Send message to client
   */
  sendMessageToClient(messageText, conversationId = null) {
    if (!this.running) {
      return false;
    }

    if (!conversationId) {
      return false;
    }

    const command = {
      type: "send_message",
      message: messageText,
      conversationId,
      username: conversationId,
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
    } else {
      this.pendingSendMessage = command;
    }

    return true;
  }

  /**
   * Click client in Fiverr
   */
  clickClientInFiverr(username = null, useFirstClient = false) {
    if (useFirstClient) {
      const command = { type: "clickFirstClient" };

      if (!this.running) {
        return false;
      }

      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);

        return true;
      } else {
        this.pendingClickCommands.push(command);

        return false;
      }
    } else {
      if (!username) {
        return false;
      }

      const command = {
        type: "click_client",
        username: username,
        useFirstClient: false,
      };

      if (!this.running) {
        return false;
      }

      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);

        return true;
      } else {
        this.pendingClickCommands.push(command);

        return false;
      }
    }
  }

  /**
   * Navigate to URL
   */
  navigateToUrl(url) {
    if (!this.running) {
      return false;
    }

    const command = {
      type: "navigate",
      url: url,
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
    } else {
    }

    return true;
  }

  /**
   * Get clients property (for compatibility)
   */
  get clients() {
    return {
      size: this.connectedClients.size,
      has: () => this.connectedClients.size > 0,
      [Symbol.iterator]: () => this.connectedClients.keys(),
    };
  }
}
