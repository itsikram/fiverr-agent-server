/**
 * Message Server for receiving Fiverr inbox data from browser extension via WebSocket
 */
import { WebSocketServer } from "ws";
import http from "http";
import { EventEmitter } from "events";
import { MongoClient } from "mongodb";
import crypto from "crypto";
import fs from "fs";
import path from "path";
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
      process.env.MONGODB_URI ||
      process.env.MONGODB_URL ||
      ""
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

    // Data storage for Expo Go clients
    this.storedMessageData = null;
    this.storedClientData = new Map(); // key -> data
    this.storedClientList = null;
    this.storedNewMessages = [];
    this.storedClientActivations = [];

    // Push notification tokens (session_id -> pushToken)
    this.pushTokens = new Map(); // session_id -> pushToken

    // Seller profiles
    this.sellerProfilesPath = path.join(__dirname, "seller_profiles.json");
    this.sellerProfiles = new Map(); // username -> profile
    this.sellerProfile = null; // current (most recently received)

    // MongoDB
    this.mongoClient = null;
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
      tls: isAtlasLike,
    };
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
      const mongoOptions = this.getMongoClientOptions();
      this.mongoClient = new MongoClient(this.mongodbUrl, mongoOptions);

      await this.mongoClient.connect();
      const db = this.mongoClient.db(this.mongoDbName);
      await db.command({ ping: 1 });
      this.mongoDb = db;

      this.mongoProfilesCollection = db.collection(this.mongoProfilesColl);

      console.log(
        `[DEBUG] MessageServer: MongoDB connected (db=${this.mongoDbName}, coll=${this.mongoProfilesColl})`,
      );
      return this.mongoProfilesCollection;
    } catch (error) {
      const details = error?.cause?.code || error?.code || "unknown";
      console.log(
        `[WARNING] MessageServer: MongoDB connection failed (${details}): ${error.message}`,
      );
      this.mongoClient = null;
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
    const coll = await this.getMongoProfilesCollection();
    if (!coll) {
      return null;
    }
    return this.mongoClient.db(this.mongoDbName);
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
    const candidate =
      data?.clientId ||
      data?.id ||
      data?.username ||
      data?.conversationId ||
      data?.conversation_id ||
      data?.clientUsername ||
      data?.client ||
      null;
    return candidate || null;
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
      client?.clientKey,
      client?.conversationId,
      client?.conversation_id,
      client?.username,
      client?.clientUsername,
      client?.client,
      client?.profile?.username,
      client?.user?.username,
      client?.name,
      client?.displayName,
    ]
      .flatMap((item) => this.getClientLookupVariants(item))
      .filter(Boolean);

    if (candidateKeys.length === 0) {
      return false;
    }

    const normalizedAssignedIds = (assignedIds || [])
      .flatMap((item) => this.getClientLookupVariants(item))
      .filter(Boolean);

    if (normalizedAssignedIds.length === 0) {
      return false;
    }

    const isCandidateMatch = (candidateKey, assignedId) => {
      if (!candidateKey || !assignedId) {
        return false;
      }

      if (candidateKey === assignedId) {
        return true;
      }

      return (
        candidateKey.includes(assignedId) || assignedId.includes(candidateKey)
      );
    };

    return candidateKeys.some((candidateKey) => {
      return normalizedAssignedIds.some((assignedId) =>
        isCandidateMatch(candidateKey, assignedId),
      );
    });
  }

  async filterClientListForUser(user, clientListPayload) {
    const canShowAll = !user || this.normalizeRole(user.role, user) === "admin";
    if (canShowAll || !clientListPayload) {
      return clientListPayload;
    }

    const assignedIds = await this.getAssignedClientIds(user);
    if (!assignedIds.length) {
      return {
        ...clientListPayload,
        clients: [],
      };
    }

    return {
      ...clientListPayload,
      clients: (clientListPayload.clients || []).filter((client) =>
        this.clientMatchesAssignedIds(client, assignedIds),
      ),
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
    if (!coll || !normalizedUserId) {
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
    if (!coll || !normalizedUserId) {
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
      return true;
    }

    const assignedIds = await this.getAssignedClientIds(user);
    if (!assignedIds.length) {
      return false;
    }

    return assignedIds.includes(clientKey);
  }

  async buildClientDocument(data) {
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

    return {
      _id: candidateKey,
      id: data.id || candidateKey,
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
    if (!coll) {
      return null;
    }
    return coll.findOne({ email: email.toLowerCase().trim() });
  }

  async getUserByToken(token) {
    const coll = await this.getMongoUsersCollection();
    if (!coll) {
      return null;
    }
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

  async addAuthTokenToUser(email, token) {
    const coll = await this.getMongoUsersCollection();
    if (!coll) {
      return false;
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
    if (!coll) {
      throw new Error("MongoDB users collection unavailable");
    }

    const normalizedEmail = email.toLowerCase().trim();
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
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
    });
  }

  async handleRegister(req, res, body) {
    const email = (body.email || "").trim().toLowerCase();
    const username = (body.username || "").trim();
    const password = body.password || "";

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
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";

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
            } catch (error) {
              console.log(
                `[WARNING] MessageServer: Error sending message_updated to desktop ${sid}: ${error.message}`,
              );
            }
          }
        }
      } catch (err) {
        console.error(
          "[MessageServer] Failed to broadcast message_updated:",
          err?.message || err,
        );
      }

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
            } catch (error) {
              console.log(
                `[WARNING] MessageServer: Error sending message_deleted to desktop ${sid}: ${error.message}`,
              );
            }
          }
        }
      } catch (err) {
        console.error(
          "[MessageServer] Failed to broadcast message_deleted:",
          err?.message || err,
        );
      }

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
      console.log("[MessageServer] Saving assignments", {
        userId: body.userId,
        clientIds: body.clientIds || [],
      });
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
      console.log("[MessageServer] Saved assignments", assignments);
      return this.sendJsonResponse(res, 200, { assignments });
    }

    const coll = await this.getMongoAssignmentsCollection();
    if (!coll) {
      return this.sendJsonResponse(res, 200, { assignments: [] });
    }

    const assignments = await coll.find({}).sort({ updated_at: -1 }).toArray();
    return this.sendJsonResponse(res, 200, { assignments });
  }

  /**
   * Load seller profiles from MongoDB or JSON file
   */
  async loadSellerProfiles() {
    // Try MongoDB first
    const coll = await this.getMongoProfilesCollection();
    if (coll) {
      try {
        const cursor = coll.find({});
        const profiles = new Map();

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

        if (profiles.size > 0) {
          this.sellerProfiles = profiles;
          // Get most recent profile
          let latest = null;
          let latestTime = "";
          for (const profile of profiles.values()) {
            const updatedAt = profile.updated_at || "";
            if (updatedAt > latestTime) {
              latestTime = updatedAt;
              latest = profile;
            }
          }
          this.sellerProfile = latest;
          console.log(
            `[DEBUG] MessageServer: Loaded ${profiles.size} seller profile(s) from MongoDB, current: ${this.sellerProfile?.username}`,
          );
          return;
        }
      } catch (error) {
        console.log(
          `[WARNING] MessageServer: MongoDB load failed, falling back to file: ${error.message}`,
        );
      }
    }

    // Fallback: JSON file
    try {
      if (fs.existsSync(this.sellerProfilesPath)) {
        const data = JSON.parse(
          fs.readFileSync(this.sellerProfilesPath, "utf-8"),
        );
        const profiles = new Map();

        if (typeof data === "object" && data !== null) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === "object" && value !== null && value.username) {
              profiles.set(value.username, value);
            }
          }
        }

        if (profiles.size > 0) {
          this.sellerProfiles = profiles;
          // Get most recent profile
          let latest = null;
          let latestTime = "";
          for (const profile of profiles.values()) {
            const updatedAt = profile.updated_at || "";
            if (updatedAt > latestTime) {
              latestTime = updatedAt;
              latest = profile;
            }
          }
          this.sellerProfile = latest;
          console.log(
            `[DEBUG] MessageServer: Loaded ${profiles.size} seller profile(s) from file, current: ${this.sellerProfile?.username}`,
          );
        } else {
          this.sellerProfile = null;
        }
      } else {
        // Try legacy seller_profile.json
        const legacyPath = path.join(__dirname, "seller_profile.json");
        if (fs.existsSync(legacyPath)) {
          const single = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
          if (
            typeof single === "object" &&
            single !== null &&
            single.username
          ) {
            const username = single.username;
            this.sellerProfiles.set(username, single);
            this.sellerProfile = single;
            console.log(
              `[DEBUG] MessageServer: Migrated legacy seller_profile.json, username=${username}`,
            );
          } else {
            this.sellerProfiles = new Map();
            this.sellerProfile = null;
          }
        } else {
          this.sellerProfiles = new Map();
          this.sellerProfile = null;
        }
      }
    } catch (error) {
      console.log(
        `[WARNING] MessageServer: Could not load seller profiles: ${error.message}`,
      );
      this.sellerProfiles = new Map();
      this.sellerProfile = null;
    }
  }

  /**
   * Save seller profiles to MongoDB and JSON file
   */
  async saveSellerProfiles() {
    if (this.sellerProfiles.size === 0) {
      return;
    }

    // Save to MongoDB
    const coll = await this.getMongoProfilesCollection();
    if (coll) {
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
        console.log(
          `[DEBUG] MessageServer: Saved ${this.sellerProfiles.size} seller profile(s) to MongoDB`,
        );
      } catch (error) {
        console.log(
          `[ERROR] MessageServer: Could not save seller profiles to MongoDB: ${error.message}`,
        );
      }
    }

    // Save to JSON file
    try {
      const data = Object.fromEntries(this.sellerProfiles);
      fs.writeFileSync(
        this.sellerProfilesPath,
        JSON.stringify(data, null, 2),
        "utf-8",
      );
      console.log(
        `[DEBUG] MessageServer: Saved ${this.sellerProfiles.size} seller profile(s) to ${this.sellerProfilesPath}`,
      );
    } catch (error) {
      if (!this.mongodbUrl) {
        console.log(
          `[ERROR] MessageServer: Could not save seller_profiles.json: ${error.message}`,
        );
      }
    }
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

      const grouped = new Map();
      for (const doc of docs) {
        const conversationId =
          doc.conversationId || doc.clientId || doc._id || null;
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
          sender: doc.sender || (doc.isFromMe ? "me" : "client"),
          isFromMe: Boolean(doc.isFromMe),
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
      console.log(
        `[WARNING] MessageServer: Could not load messages from MongoDB: ${error.message}`,
      );
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

    const conversationId =
      data.conversationId ||
      data.conversation_id ||
      data.clients?.[0]?.conversationId ||
      data.clients?.[0]?.username ||
      null;
    const messages = data.messages || [];
    if (!conversationId && messages.length === 0) {
      return;
    }

    try {
      const coll = db.collection(this.mongoMessagesColl);
      const clientColl = db.collection(this.mongoClientsColl);
      const clientCandidates = [data, ...(data.clients || [])].filter(Boolean);

      let clientDoc = null;
      for (const candidate of clientCandidates) {
        const candidateKey = this.getClientLookupKey(candidate);
        if (!candidateKey) {
          continue;
        }

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

      for (const [index, message] of messages.entries()) {
        const messageId =
          message.id ||
          `${conversationId || "conversation"}_${message.timestamp || message.time || Date.now()}_${index}`;
        const payload = {
          _id: messageId,
          id: messageId,
          clientId,
          conversationId,
          sender: message.sender || (message.isFromMe ? "me" : "client"),
          text: message.text || message.content || message.message || "",
          timestamp:
            message.timestamp ||
            message.time ||
            message.date ||
            new Date().toISOString(),
          isFromMe: Boolean(message.isFromMe),
          metadata: message.metadata || {},
          created_at:
            message.created_at || message.createdAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...message,
        };

        await coll.updateOne(
          { _id: payload._id },
          { $set: payload },
          { upsert: true },
        );
      }

      console.log(
        `[DEBUG] MessageServer: Saved ${messages.length} message(s) to MongoDB (conversationId=${conversationId})`,
      );
    } catch (error) {
      console.log(
        `[ERROR] MessageServer: Could not save messages to MongoDB: ${error.message}`,
      );
    }
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

      console.log(
        `[DEBUG] MessageServer: Saved client data to MongoDB (key=${payload._id})`,
      );
    } catch (error) {
      console.log(
        `[ERROR] MessageServer: Could not save client data to MongoDB: ${error.message}`,
      );
    }
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

      console.log(
        `[DEBUG] MessageServer: Saved ${clients.length} client(s) from client list to MongoDB`,
      );
    } catch (error) {
      console.log(
        `[ERROR] MessageServer: Could not save client list to MongoDB: ${error.message}`,
      );
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
   * Handle message received
   */
  onMessageReceived(data) {
    console.log(
      `[DEBUG] MessageServer: _on_message_received() called with data`,
    );
    console.log(
      `[DEBUG] MessageServer: Message count: ${(data.messages || []).length}`,
    );

    const normalizedData = JSON.parse(JSON.stringify(data));
    this.storedMessageData = normalizedData;

    // Save to MongoDB
    this.saveMessagesToMongo(normalizedData).catch((err) => {
      console.log(
        `[WARNING] MessageServer: Error saving messages to MongoDB: ${err.message}`,
      );
    });

    // Emit event
    this.emit("message_received", data);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "message_data",
      data: data,
    });

    console.log(`[DEBUG] MessageServer: Signal emitted and data stored`);
  }

  /**
   * Handle client data received
   */
  onClientDataReceived(data) {
    console.log(
      `[DEBUG] MessageServer: _on_client_data_received() called with data`,
    );

    const normalizedData = JSON.parse(JSON.stringify(data));
    const key =
      this.getClientLookupKey(normalizedData) ||
      normalizedData.username ||
      normalizedData.conversationId ||
      "default";
    this.storedClientData.set(key, normalizedData);

    // Save to MongoDB
    this.saveClientDataToMongo(normalizedData).catch((err) => {
      console.log(
        `[WARNING] MessageServer: Error saving client data to MongoDB: ${err.message}`,
      );
    });

    // Emit event
    this.emit("client_data_received", data);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "client_data",
      data: data,
    });

    console.log(
      `[DEBUG] MessageServer: Client data signal emitted and data stored`,
    );
  }

  /**
   * Handle client list received
   */
  onClientListReceived(data) {
    console.log(
      `[DEBUG] MessageServer: _on_client_list_received() called with data`,
    );
    console.log(
      `[DEBUG] MessageServer: Client list count: ${(data.clients || []).length}`,
    );

    // Store data
    this.storedClientList = JSON.parse(JSON.stringify(data));

    // Save to MongoDB
    this.saveClientListToMongo(data).catch((err) => {
      console.log(
        `[WARNING] MessageServer: Error saving client list to MongoDB: ${err.message}`,
      );
    });

    // Emit event
    this.emit("client_list_received", data);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "client_list_data",
      data: data,
    });

    console.log(
      `[DEBUG] MessageServer: Client list signal emitted and data stored`,
    );
  }

  /**
   * Handle new message detected
   */
  onNewMessageDetected(data) {
    console.log(
      `[DEBUG] MessageServer: _on_new_message_detected() called with data`,
    );

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

    // Send push notifications to all registered tokens (works even when app is closed)
    this.sendPushNotificationForMessage(data).catch((error) => {
      console.error(
        `[ERROR] MessageServer: Error sending push notification: ${error.message}`,
      );
    });

    console.log(
      `[DEBUG] MessageServer: New message detection signal emitted and data stored`,
    );
  }

  /**
   * Send push notification for new message
   * This works even when the app is completely closed
   */
  async sendPushNotificationForMessage(messageData) {
    const {
      clientName,
      messageText,
      conversationId,
      username,
      clientUsername,
      isTest,
    } = messageData;

    // Get all registered push tokens
    const pushTokens = Array.from(this.pushTokens.values());

    if (pushTokens.length === 0) {
      console.log(
        `[DEBUG] MessageServer: No push tokens registered, skipping push notification`,
      );
      return;
    }

    const title = isTest
      ? "🧪 Test Notification"
      : `New message from ${clientName || "Client"}`;
    const body = isTest
      ? `📱 ${messageText || "This is a test notification!"}`
      : messageText || "You have a new message";

    // Truncate body if too long
    const maxLength = 100;
    const truncatedBody =
      body.length > maxLength ? body.substring(0, maxLength - 3) + "..." : body;

    console.log(
      `[DEBUG] MessageServer: Sending push notification to ${pushTokens.length} device(s)`,
    );

    const result = await pushNotificationService.sendPushNotifications(
      pushTokens,
      {
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
      },
    );

    if (result.success) {
      console.log(
        `[DEBUG] MessageServer: Push notification sent successfully to ${result.sentCount || pushTokens.length} device(s)`,
      );
    } else {
      console.error(
        `[ERROR] MessageServer: Failed to send push notification: ${result.error}`,
      );
    }
  }

  /**
   * Handle client activated
   */
  onClientActivated(username) {
    console.log(
      `[DEBUG] MessageServer: _on_client_activated() called with username: ${username}`,
    );

    // Store data
    if (!this.storedClientActivations.includes(username)) {
      this.storedClientActivations.push(username);
      if (this.storedClientActivations.length > 100) {
        this.storedClientActivations.shift();
      }
    }

    // Emit event
    this.emit("client_activated", username);

    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: "client_activated",
      data: { username: username },
    });

    console.log(
      `[DEBUG] MessageServer: Client activated signal emitted and data stored`,
    );
  }

  /**
   * Handle new client detected (first-time client with clock icon)
   */
  onNewClientDetected(data) {
    const { clientUsername, clientName, clientData, url, timestamp } = data;
    console.log(
      `[DEBUG] MessageServer: onNewClientDetected() called with username: ${clientUsername}`,
    );

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

    // Broadcast to Expo clients via WebSocket (if app is running)
    this.broadcastToExpoClients({
      type: "new_client_detected",
      data: newClientInfo,
    });

    // Send push notifications to all registered tokens (works even when app is closed)
    this.sendPushNotificationForNewClient(newClientInfo).catch((error) => {
      console.error(
        `[ERROR] MessageServer: Error sending push notification for new client: ${error.message}`,
      );
    });

    console.log(
      `[DEBUG] MessageServer: New client detection signal emitted and notification sent`,
    );
  }

  /**
   * Send push notification for new client
   * This works even when the app is completely closed
   */
  async sendPushNotificationForNewClient(clientInfo) {
    const { username, name } = clientInfo;

    // Get all registered push tokens
    const pushTokens = Array.from(this.pushTokens.values());

    if (pushTokens.length === 0) {
      console.log(
        `[DEBUG] MessageServer: No push tokens registered, skipping push notification for new client`,
      );
      return;
    }

    const title = `🎉 New Client: ${name || username}`;
    const body = `You have a new client message from ${name || username}!`;

    console.log(
      `[DEBUG] MessageServer: Sending push notification for new client to ${pushTokens.length} device(s)`,
    );

    const result = await pushNotificationService.sendPushNotifications(
      pushTokens,
      {
        title,
        body,
        data: {
          type: "new_client",
          username: username,
          clientName: name || username,
          conversationId: username,
          isNewClient: true,
        },
      },
    );

    if (result.success) {
      console.log(
        `[DEBUG] MessageServer: Push notification for new client sent successfully to ${result.sentCount || pushTokens.length} device(s)`,
      );
    } else {
      console.error(
        `[ERROR] MessageServer: Failed to send push notification for new client: ${result.error}`,
      );
    }
  }

  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws, req) {
    console.log(`[DEBUG] MessageServer: New WebSocket connection established`);

    // Store session info on websocket object
    ws._sessionId = null;
    ws._clientType = "browser";

    // Set up message handler
    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(
          `[DEBUG] MessageServer: Received WebSocket message: ${data.type || "unknown"}`,
        );
        await this.handleMessage(data, ws);
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.log(
            `[ERROR] MessageServer: Invalid JSON from client: ${error.message}`,
          );
          console.log(
            `[ERROR] MessageServer: Raw message: ${message.toString().substring(0, 100)}`,
          );
        } else {
          console.log(
            `[ERROR] MessageServer: Error handling message: ${error.message}`,
          );
          console.error(error);
        }
      }
    });

    ws.on("close", () => {
      const sessionId = ws._sessionId;
      console.log(
        `[DEBUG] MessageServer: WebSocket client disconnected: ${sessionId}`,
      );

      // Clean up connection
      const needBroadcastOnline =
        sessionId && this.browserProfileBySession.has(sessionId);

      if (sessionId) {
        this.connectedClients.delete(sessionId);
        this.clientTypes.delete(sessionId);
        if (this.browserProfileBySession.has(sessionId)) {
          this.browserProfileBySession.delete(sessionId);
        }
      }

      if (ws && this.clientSessions.has(ws)) {
        this.clientSessions.delete(ws);
      }

      if (needBroadcastOnline) {
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

      console.log(
        `[DEBUG] MessageServer: Cleaned up connection for session: ${sessionId}`,
      );
    });

    ws.on("error", (error) => {
      console.log(`[ERROR] MessageServer: WebSocket error: ${error.message}`);
    });
  }

  /**
   * Handle incoming message from WebSocket client
   */
  async handleMessage(data, ws) {
    const msgType = data.type;
    const sessionId = ws._sessionId;
    console.log(
      `[DEBUG] MessageServer: Received message type=${msgType} from session=${sessionId || "not connected yet"}`,
    );

    if (!sessionId && msgType !== "connect") {
      console.log(
        `[WARNING] MessageServer: Received ${msgType} message before connect, waiting for connect message...`,
      );
      return;
    }

    if (msgType === "connect") {
      const newSessionId = data.session_id || generateSessionId(this);
      const clientType = data.client_type || "browser";

      console.log(
        `[DEBUG] MessageServer: Processing connect message - session_id: ${newSessionId}, client_type: ${clientType}`,
      );

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

      this.connectedClients.set(newSessionId, ws);
      this.clientSessions.set(ws, newSessionId);
      this.clientTypes.set(newSessionId, clientType);

      console.log(
        `[DEBUG] MessageServer: WebSocket client connected: ${newSessionId} (type: ${clientType})`,
      );
      console.log(
        `[DEBUG] MessageServer: Total connected clients: ${this.connectedClients.size}`,
      );

      // Send connection confirmation
      try {
        const confirmMessage = JSON.stringify({
          type: "connected",
          session_id: newSessionId,
          status: "ok",
        });
        ws.send(confirmMessage);
        console.log(
          `[DEBUG] MessageServer: Sent connection confirmation to ${newSessionId}`,
        );
      } catch (error) {
        console.log(
          `[ERROR] MessageServer: Error sending connection confirmation: ${error.message}`,
        );
      }

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
      }
    } else if (msgType === "message_data") {
      const messageData = data.data || data;
      console.log(`[DEBUG] MessageServer: Received message data via WebSocket`);
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
      console.log(`[DEBUG] MessageServer: Received client data via WebSocket`);
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
      console.log(
        `[DEBUG] MessageServer: Received client list data via WebSocket`,
      );
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
      console.log(
        `[DEBUG] MessageServer: Received new message detection notification`,
      );
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
      console.log(
        `[DEBUG] MessageServer: Received client activated notification: ${username}`,
      );

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
      console.log(
        `[DEBUG] MessageServer: Received new client detection notification`,
      );
      this.onNewClientDetected(newClientData);

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "New client detection received",
        }),
      );
    } else if (msgType === "seller_profile") {
      console.log(
        `[DEBUG] MessageServer: Received seller_profile via WebSocket`,
        data,
      );
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

        console.log(
          `[DEBUG] MessageServer: Broadcasting seller_profile with avatarUrl:`,
          {
            username: currentWithOnline.username,
            avatarUrl:
              currentWithOnline.avatarUrl ||
              currentWithOnline.avatar_url ||
              "null",
          },
        );

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
            } catch (error) {
              console.log(
                `[WARNING] MessageServer: Error sending seller_profile to desktop ${sid}: ${error.message}`,
              );
            }
          }
        }

        console.log(
          `[DEBUG] MessageServer: Seller profile saved: username=${username}, total profiles=${this.sellerProfiles.size}, online=${online.has(username)}`,
        );
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
    } else if (msgType === "request_all_data") {
      console.log(
        `[DEBUG] MessageServer: Expo client requesting all stored data`,
      );
      await this.sendStoredDataToExpo(ws);
    } else if (msgType === "request_client_list") {
      const currentUser = ws._user || null;
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
      }
    } else if (msgType === "request_messages") {
      if (this.storedMessageData) {
        const currentUser = ws._user || null;
        const canShowAll =
          currentUser &&
          this.normalizeRole(currentUser.role, currentUser) === "admin";

        // Load persisted payloads and send appropriate view depending on role
        const persisted = await this.loadMessagesFromMongo();
        let payloads =
          persisted.length > 0 ? persisted : [this.storedMessageData];

        if (!canShowAll) {
          const assignedIds = await this.getAssignedClientIds(currentUser);
          const assignedSet = new Set(assignedIds.map((i) => String(i)));
          payloads = (payloads || [])
            .filter((p) => {
              const conv =
                p.conversationId ||
                (p.clients &&
                  p.clients[0] &&
                  (p.clients[0]._id ||
                    p.clients[0].id ||
                    p.clients[0].username));
              if (!conv) return false;
              return assignedSet.has(String(conv));
            })
            .map((p) => {
              const copy = JSON.parse(JSON.stringify(p));
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
              return copy;
            });
        }

        for (const pl of payloads || []) {
          if (pl) {
            ws.send(JSON.stringify({ type: "message_data", data: pl }));
          }
        }
      }

      const target = data.conversationId || data.username || null;
      if (target) {
        const browserClients = Array.from(
          this.connectedClients.entries(),
        ).filter(([sid]) => this.clientTypes.get(sid) === "browser");

        if (browserClients.length > 0) {
          const message = JSON.stringify({
            type: "commands",
            commands: [
              {
                type: "trigger",
                action: "extract_messages",
                conversationId: target,
                username: target,
              },
            ],
          });

          for (const [, browserWs] of browserClients) {
            try {
              browserWs.send(message);
              console.log(
                `[DEBUG] MessageServer: Message extraction triggered for ${target}`,
              );
            } catch (error) {
              console.log(
                `[WARNING] MessageServer: Error forwarding message extraction trigger to browser client: ${error.message}`,
              );
            }
          }
        }
      }
    } else if (msgType === "request_client_data") {
      const clientKey = data.username || data.conversationId;
      const currentUser = ws._user || null;
      const canAccess =
        !currentUser ||
        this.normalizeRole(currentUser.role, currentUser) === "admin" ||
        (await this.canUserAccessClient(currentUser, clientKey));
      if (clientKey && this.storedClientData.has(clientKey) && canAccess) {
        ws.send(
          JSON.stringify({
            type: "client_data",
            data: this.storedClientData.get(clientKey),
          }),
        );
      }
    } else if (msgType === "trigger") {
      const action = data.action;
      console.log(
        `[DEBUG] MessageServer: Expo client requesting trigger: ${action}`,
      );

      const command = {
        type: "trigger",
        action: action,
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
            console.log(
              `[DEBUG] MessageServer: Trigger command forwarded to browser client`,
            );
          } catch (error) {
            console.log(
              `[WARNING] MessageServer: Error forwarding trigger to browser client: ${error.message}`,
            );
          }
        }
      } else {
        console.log(
          `[WARNING] MessageServer: No browser extension clients connected to forward trigger`,
        );
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: `Trigger command sent: ${action}`,
        }),
      );
    } else if (msgType === "click_client" || msgType === "clickFirstClient") {
      const username = data.username;
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

      console.log(
        `[DEBUG] MessageServer: Expo client requesting to click client: username=${username}, use_first_client=${useFirstClient}`,
      );
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
            console.log(
              `[DEBUG] MessageServer: Click client command forwarded to browser client`,
            );
          } catch (error) {
            console.log(
              `[WARNING] MessageServer: Error forwarding click_client to browser client: ${error.message}`,
            );
          }
        }
      } else {
        console.log(
          `[WARNING] MessageServer: No browser extension clients connected to forward click_client`,
        );
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: `Click client command sent: ${username || "first client"}`,
        }),
      );
    } else if (msgType === "send_message") {
      const messageText = data.message;
      const conversationId = data.conversationId;
      const username =
        data.username || data.clientUsername || data.client || null;
      const targetKey = conversationId || username || null;

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

      console.log(
        `[DEBUG] MessageServer: Expo client requesting to send message: ${messageText.substring(0, 50)}...`,
      );

      const command = {
        type: "send_message",
        message: messageText.trim(),
        conversationId: conversationId || username || null,
        username: username || conversationId || null,
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
            console.log(
              `[DEBUG] MessageServer: Send message command forwarded to browser client`,
            );
          } catch (error) {
            console.log(
              `[WARNING] MessageServer: Error forwarding send_message to browser client: ${error.message}`,
            );
          }
        }
      } else {
        console.log(
          `[WARNING] MessageServer: No browser extension clients connected to forward send_message`,
        );
        this.pendingSendMessage = messageText.trim();
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Send message command sent to browser extension",
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

      console.log(
        `[DEBUG] MessageServer: Expo client requesting to fetch client details for username: ${username}`,
      );

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
        console.log(
          `[DEBUG] MessageServer: Navigating to profile URL: ${profileUrl}`,
        );

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
          console.log(
            `[DEBUG] MessageServer: Triggering client data extraction...`,
          );
          this.triggerClientExtraction();
        }, 8000);
      } catch (error) {
        console.log(
          `[ERROR] MessageServer: Error fetching client details: ${error.message}`,
        );
        console.error(error);
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

      if (status === "success") {
        console.log(
          `[SUCCESS] MessageServer: Command '${commandType}' executed successfully`,
        );
      } else if (status === "warning") {
        if (
          message.toLowerCase().includes("content script") ||
          message.toLowerCase().includes("not ready")
        ) {
          console.log(
            `[DEBUG] MessageServer: Content script readiness warning (expected): ${message}`,
          );
        } else {
          console.log(
            `[WARNING] MessageServer: Command '${commandType}' warning: ${message}`,
          );
        }
      } else if (status === "error") {
        console.log(
          `[ERROR] MessageServer: Command '${commandType}' failed: ${message}`,
        );
        if (error) {
          console.log(`[ERROR] MessageServer: Error details: ${error}`);
        }
      } else {
        console.log(
          `[DEBUG] MessageServer: Command '${commandType}' status: ${status} - ${message}`,
        );
      }

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

      console.log(
        `[DEBUG] MessageServer: Expo client requesting to navigate to: ${url}`,
      );

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
            console.log(
              `[DEBUG] MessageServer: Navigate command forwarded to browser client`,
            );
          } catch (error) {
            console.log(
              `[WARNING] MessageServer: Error forwarding navigate to browser client: ${error.message}`,
            );
          }
        }
      } else {
        console.log(
          `[WARNING] MessageServer: No browser extension clients connected to forward navigate`,
        );
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: `Navigate command sent: ${url}`,
        }),
      );
    } else if (msgType === "reload") {
      console.log(
        `[DEBUG] MessageServer: Expo client requesting to reload activated Fiverr tab`,
      );

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
            console.log(
              `[DEBUG] MessageServer: Reload command forwarded to browser client`,
            );
          } catch (error) {
            console.log(
              `[WARNING] MessageServer: Error forwarding reload to browser client: ${error.message}`,
            );
          }
        }
      } else {
        console.log(
          `[WARNING] MessageServer: No browser extension clients connected to forward reload`,
        );
      }

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Reload command sent to browser extension",
        }),
      );
    } else if (msgType === "register_push_token") {
      // Handle push token registration from Expo client
      const pushToken = data.pushToken || data.push_token;
      if (pushToken && sessionId) {
        this.pushTokens.set(sessionId, pushToken);
        console.log(
          `[DEBUG] MessageServer: Registered push token for session ${sessionId}`,
        );

        ws.send(
          JSON.stringify({
            type: "ack",
            status: "success",
            message: "Push token registered",
          }),
        );
      } else {
        console.warn(
          `[WARNING] MessageServer: Invalid push token registration - sessionId: ${sessionId}, token: ${pushToken ? "provided" : "missing"}`,
        );
        ws.send(
          JSON.stringify({
            type: "ack",
            status: "error",
            message: "Invalid push token registration",
          }),
        );
      }
    } else if (msgType === "test_notification") {
      // Handle test notification from browser extension
      console.log(
        `[DEBUG] MessageServer: Test notification received from browser extension`,
      );

      const testData = data.data || data;

      // Broadcast test notification to Expo clients
      this.broadcastToExpoClients({
        type: "new_message_detected",
        data: {
          clientName: testData.clientName || "Test Client",
          messageText: testData.messageText || "This is a test notification!",
          conversationId: testData.conversationId || "test_" + Date.now(),
          username: testData.username || "testuser",
          clientUsername: testData.username || "testuser",
          isTest: true,
        },
      });

      console.log(
        `[DEBUG] MessageServer: Test notification broadcasted to Expo clients`,
      );

      ws.send(
        JSON.stringify({
          type: "ack",
          status: "success",
          message: "Test notification sent to Android app",
        }),
      );
    } else {
      console.log(`[WARNING] MessageServer: Unknown message type: ${msgType}`);
    }
  }

  /**
   * Send stored data to Expo client
   */
  async sendStoredDataToExpo(ws) {
    console.log(`[DEBUG] MessageServer: Sending stored data to Expo client`);

    // Snapshot data
    const currentUser = ws._user || null;
    const canShowAll =
      currentUser &&
      this.normalizeRole(currentUser.role, currentUser) === "admin";
    const snapshotMessage =
      this.storedMessageData && canShowAll
        ? JSON.parse(JSON.stringify(this.storedMessageData))
        : null;
    const persistedMessagePayloads = await this.loadMessagesFromMongo();
    let messagePayloads =
      persistedMessagePayloads.length > 0
        ? persistedMessagePayloads
        : snapshotMessage
          ? [snapshotMessage]
          : [];

    // For non-admin users, restrict and transform messages: only send assigned clients' messages
    if (!canShowAll) {
      const assignedIds = await this.getAssignedClientIds(currentUser);
      const assignedSet = new Set(assignedIds.map((item) => String(item)));

      messagePayloads = messagePayloads
        .filter((p) => {
          const conv =
            p.conversationId ||
            (p.clients &&
              p.clients[0] &&
              (p.clients[0]._id || p.clients[0].id || p.clients[0].username));
          if (!conv) return false;
          return assignedSet.has(String(conv));
        })
        .map((p) => {
          const copy = JSON.parse(JSON.stringify(p));
          copy.messages = (copy.messages || []).map((m) => {
            const out = { ...m };
            if (out.editedText) {
              out.text = out.editedText;
              out.isEdited = true;
            }
            // Remove original_text to avoid exposing Fiverr text if edited
            if (out.original_text) delete out.original_text;
            if (out.originalText) delete out.originalText;
            return out;
          });
          return copy;
        });
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
      const assignedIds = await this.getAssignedClientIds(currentUser);
      for (const [key, value] of this.storedClientData.entries()) {
        if (
          assignedIds.includes(key) ||
          assignedIds.includes(value.username) ||
          assignedIds.includes(value.conversationId)
        ) {
          snapshotClientData.set(key, JSON.parse(JSON.stringify(value)));
        }
      }
    }
    const snapshotNewMessages = this.storedNewMessages.slice(-10);
    const snapshotActivations = this.storedClientActivations.slice(-10);
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

    // Send data
    try {
      for (const messagePayload of messagePayloads) {
        ws.send(JSON.stringify({ type: "message_data", data: messagePayload }));
      }

      if (messagePayloads.length > 0) {
        console.log(
          `[DEBUG] MessageServer: Sent ${messagePayloads.length} persisted message payload(s) to Expo client`,
        );
      }

      if (snapshotClientList) {
        ws.send(
          JSON.stringify({
            type: "client_list_data",
            data: snapshotClientList,
          }),
        );
        console.log(
          `[DEBUG] MessageServer: Sent stored client list to Expo client`,
        );
      }

      for (const [, clientData] of snapshotClientData.entries()) {
        ws.send(JSON.stringify({ type: "client_data", data: clientData }));
      }

      for (const newMsg of snapshotNewMessages) {
        ws.send(JSON.stringify({ type: "new_message_detected", data: newMsg }));
      }

      for (const username of snapshotActivations) {
        ws.send(
          JSON.stringify({ type: "client_activated", data: { username } }),
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
        console.log(
          `[DEBUG] MessageServer: Sent stored seller profile to Expo client`,
        );
      }

      if (snapshotSellerProfiles.length > 0) {
        ws.send(
          JSON.stringify({
            type: "seller_profiles",
            data: snapshotSellerProfiles,
          }),
        );
        console.log(
          `[DEBUG] MessageServer: Sent ${snapshotSellerProfiles.length} seller profile(s) to Expo client`,
        );
      }

      // Notify sync complete
      ws.send(
        JSON.stringify({
          type: "sync_complete",
          status: "ok",
          message: "All stored data sent",
        }),
      );
      console.log(
        `[DEBUG] MessageServer: Stored data sync complete for Expo client`,
      );
    } catch (error) {
      console.log(
        `[WARNING] MessageServer: Could not send sync_complete to Expo: ${error.message}`,
      );
    }
  }

  /**
   * Send pending commands to client
   */
  async sendPendingCommands(sessionId, ws) {
    const commands = [];

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
      commands.push({
        type: "send_message",
        message: this.pendingSendMessage,
      });
      this.pendingSendMessage = null;
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
  broadcastToExpoClients(message) {
    if (this.connectedClients.size === 0) {
      return;
    }

    const messageJson = JSON.stringify(message);
    const disconnected = [];

    for (const [sessionId, ws] of this.connectedClients.entries()) {
      if (this.clientTypes.get(sessionId) === "expo") {
        try {
          ws.send(messageJson);
        } catch (error) {
          console.log(
            `[WARNING] MessageServer: Error broadcasting to Expo client ${sessionId}: ${error.message}`,
          );
          disconnected.push(sessionId);
        }
      }
    }

    // Clean up disconnected clients
    for (const sessionId of disconnected) {
      this.connectedClients.delete(sessionId);
      this.clientTypes.delete(sessionId);
      this.pushTokens.delete(sessionId); // Also remove push token
      const ws = this.connectedClients.get(sessionId);
      if (ws && this.clientSessions.has(ws)) {
        this.clientSessions.delete(ws);
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
        console.log(
          `[WARNING] MessageServer: Error sending to client ${sessionId}: ${error.message}`,
        );
        disconnected.push(sessionId);
      }
    }

    // Clean up disconnected clients
    for (const sessionId of disconnected) {
      this.connectedClients.delete(sessionId);
      this.clientTypes.delete(sessionId);
      const ws = this.connectedClients.get(sessionId);
      if (ws && this.clientSessions.has(ws)) {
        this.clientSessions.delete(ws);
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
        console.log(
          `[DEBUG] MessageServer: WebSocket upgrade request detected for ${req.url}`,
        );
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
            console.error("[MessageServer] Error handling register:", error);
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
            console.error("[MessageServer] Error handling login:", error);
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
            console.error("[MessageServer] Error handling auth me:", error);
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
            console.error("[MessageServer] Error handling logout:", error);
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
            console.error(
              "[MessageServer] Error handling my assignments:",
              error,
            );
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
            console.error(
              "[MessageServer] Error handling admin clients:",
              error,
            );
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
            console.error("[MessageServer] Error handling clients:", error);
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
            console.error(
              "[MessageServer] Error handling admin client update:",
              error,
            );
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
            console.error(
              "[MessageServer] Error handling admin messages:",
              error,
            );
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
            console.error(
              "[MessageServer] Error handling admin message update:",
              error,
            );
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
            console.error("[MessageServer] Error handling admin users:", error);
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
            console.error(
              "[MessageServer] Error handling admin assignments:",
              error,
            );
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
      console.log(
        `[DEBUG] MessageServer: Server already running on port ${this.port}`,
      );
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
      console.log(
        `[DEBUG] MessageServer: WebSocket connection attempt from ${clientIp}`,
      );
      console.log(
        `[DEBUG] MessageServer: User-Agent: ${userAgent.substring(0, 100)}`,
      );
      console.log(`[DEBUG] MessageServer: Request URL: ${req.url}`);
      this.handleWebSocketConnection(ws, req);
    });

    this.wss.on("error", (error) => {
      console.log(
        `[ERROR] MessageServer: WebSocket server error: ${error.message}`,
      );
      console.error(error);
    });

    this.wss.on("headers", (headers, req) => {
      // Log WebSocket handshake headers for debugging
      console.log(`[DEBUG] MessageServer: WebSocket handshake headers:`, {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        "sec-websocket-key": req.headers["sec-websocket-key"]
          ? "present"
          : "missing",
      });
    });

    // Start listening
    this.httpServer.listen(this.port, "0.0.0.0", () => {
      console.log(
        `[SUCCESS] MessageServer: ========================================`,
      );
      console.log(
        `[SUCCESS] MessageServer: WebSocket server started successfully!`,
      );
      console.log(`[SUCCESS] MessageServer: Port: ${this.port}`);
      console.log(`[SUCCESS] MessageServer: URL: ws://0.0.0.0:${this.port}`);
      console.log(
        `[SUCCESS] MessageServer: Health: http://localhost:${this.port}/health`,
      );
      console.log(
        `[SUCCESS] MessageServer: ========================================`,
      );
    });

    this.httpServer.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.log(
          `[ERROR] MessageServer: Port ${this.port} is already in use!`,
        );
        console.log(
          `[ERROR] MessageServer: This usually means another instance is running`,
        );
      } else {
        console.log(
          `[ERROR] MessageServer: HTTP server error: ${error.message}`,
        );
      }
      this.running = false;
    });
  }

  /**
   * Stop the server
   */
  stop() {
    console.log(
      `[DEBUG] MessageServer: stop() called, running=${this.running}`,
    );

    if (!this.running && !this.httpServer && !this.wss) {
      console.log(`[DEBUG] MessageServer: Already stopped`);
      return;
    }

    this.running = false;

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
      this.wss.close(() => {
        console.log(`[DEBUG] MessageServer: WebSocket server closed`);
      });
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close(() => {
        console.log(`[DEBUG] MessageServer: HTTP server closed`);
      });
      this.httpServer = null;
    }

    // Close MongoDB connection
    if (this.mongoClient) {
      this.mongoClient.close().catch(() => {});
      this.mongoClient = null;
      this.mongoProfilesCollection = null;
    }

    console.log(`[DEBUG] MessageServer: Server stopped and cleaned up`);
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
    console.log(`[DEBUG] MessageServer: trigger_extraction() called`);
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_messages",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Trigger command sent via WebSocket`);
    } else {
      this.pendingTrigger = true;
      console.log(
        `[DEBUG] MessageServer: No clients connected, trigger queued`,
      );
    }

    return true;
  }

  /**
   * Trigger client data extraction
   */
  triggerClientExtraction() {
    console.log(`[DEBUG] MessageServer: trigger_client_extraction() called`);
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_client_data",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(
        `[DEBUG] MessageServer: Client trigger command sent via WebSocket`,
      );
    } else {
      this.pendingClientTrigger = true;
      console.log(
        `[DEBUG] MessageServer: No clients connected, trigger queued`,
      );
    }

    return true;
  }

  /**
   * Trigger client list extraction
   */
  triggerClientListExtraction() {
    console.log(
      `[DEBUG] MessageServer: trigger_client_list_extraction() called`,
    );
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }

    const command = {
      type: "trigger",
      action: "extract_client_list",
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(
        `[DEBUG] MessageServer: Client list trigger command sent via WebSocket`,
      );
    } else {
      this.pendingClientListTrigger = true;
      console.log(
        `[DEBUG] MessageServer: No clients connected, trigger queued`,
      );
    }

    return true;
  }

  /**
   * Send message to client
   */
  sendMessageToClient(messageText) {
    console.log(
      `[DEBUG] MessageServer: send_message_to_client() called with message: ${messageText.substring(0, 50)}...`,
    );
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }

    const command = {
      type: "send_message",
      message: messageText,
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(
        `[DEBUG] MessageServer: Send message command sent via WebSocket`,
      );
    } else {
      this.pendingSendMessage = messageText;
      console.log(
        `[DEBUG] MessageServer: No clients connected, message queued`,
      );
    }

    return true;
  }

  /**
   * Click client in Fiverr
   */
  clickClientInFiverr(username = null, useFirstClient = false) {
    if (useFirstClient) {
      console.log(
        `[DEBUG] MessageServer: click_client_in_fiverr() called with use_first_client=True`,
      );
      const command = { type: "clickFirstClient" };

      if (!this.running) {
        console.log(`[ERROR] MessageServer: Server is not running`);
        return false;
      }

      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);
        console.log(
          `[DEBUG] MessageServer: Click client command sent via WebSocket`,
        );
        return true;
      } else {
        this.pendingClickCommands.push(command);
        console.log(
          `[WARNING] MessageServer: No clients connected, click command queued`,
        );
        return false;
      }
    } else {
      console.log(
        `[DEBUG] MessageServer: click_client_in_fiverr() called with username: ${username}`,
      );
      if (!username) {
        console.log(
          `[ERROR] MessageServer: Username is required for click_client command when use_first_client is False`,
        );
        return false;
      }

      const command = {
        type: "click_client",
        username: username,
        useFirstClient: false,
      };

      if (!this.running) {
        console.log(`[ERROR] MessageServer: Server is not running`);
        return false;
      }

      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);
        console.log(
          `[DEBUG] MessageServer: Click client command sent via WebSocket`,
        );
        return true;
      } else {
        this.pendingClickCommands.push(command);
        console.log(
          `[WARNING] MessageServer: No clients connected, click command queued`,
        );
        return false;
      }
    }
  }

  /**
   * Navigate to URL
   */
  navigateToUrl(url) {
    console.log(
      `[DEBUG] MessageServer: navigate_to_url() called with url: ${url}`,
    );
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }

    const command = {
      type: "navigate",
      url: url,
    };

    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Navigate command sent via WebSocket`);
    } else {
      console.log(
        `[WARNING] MessageServer: No clients connected, navigate command not sent`,
      );
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
