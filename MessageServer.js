/**
 * Message Server for receiving Fiverr inbox data from browser extension via WebSocket
 */
import { WebSocketServer } from 'ws';
import http from 'http';
import { EventEmitter } from 'events';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateSessionId } from './utils/serverUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MessageServer extends EventEmitter {
  constructor(port = null) {
    super();
    
    // Port configuration
    const isRender = process.env.RENDER === 'true';
    const defaultPort = isRender ? 10000 : 8765;
    this.port = port !== null ? parseInt(port) : parseInt(process.env.PORT || defaultPort);
    
    // MongoDB configuration
    this.mongodbUrl = (process.env.MONGODB_URI || process.env.MONGODB_URL || '').trim();
    this.mongoDbName = (process.env.MONGODB_DB_NAME || 'fiverr_agent').trim();
    this.mongoProfilesColl = (process.env.MONGODB_PROFILES_COLLECTION || 'seller_profiles').trim();
    this.mongoClientsColl = (process.env.MONGODB_CLIENTS_COLLECTION || 'clients').trim();
    this.mongoMessagesColl = (process.env.MONGODB_MESSAGES_COLLECTION || 'messages').trim();
    
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
    
    // Seller profiles
    this.sellerProfilesPath = path.join(__dirname, 'seller_profiles.json');
    this.sellerProfiles = new Map(); // username -> profile
    this.sellerProfile = null; // current (most recently received)
    
    // MongoDB
    this.mongoClient = null;
    this.mongoProfilesCollection = null;
    
    // Lock for thread-safe operations
    this.lock = new Map(); // Simple lock using a flag
    
    // Load seller profiles
    this.loadSellerProfiles();
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
      this.mongoClient = new MongoClient(this.mongodbUrl, {
        serverSelectionTimeoutMS: 5000
      });
      
      await this.mongoClient.connect();
      await this.mongoClient.db('admin').command({ ping: 1 });
      
      const db = this.mongoClient.db(this.mongoDbName);
      this.mongoProfilesCollection = db.collection(this.mongoProfilesColl);
      
      console.log(`[DEBUG] MessageServer: MongoDB connected (db=${this.mongoDbName}, coll=${this.mongoProfilesColl})`);
      return this.mongoProfilesCollection;
    } catch (error) {
      console.log(`[WARNING] MessageServer: MongoDB connection failed: ${error.message}`);
      this.mongoClient = null;
      this.mongoProfilesCollection = null;
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
          const username = doc.username || (typeof doc._id === 'string' ? doc._id : null);
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
          let latestTime = '';
          for (const profile of profiles.values()) {
            const updatedAt = profile.updated_at || '';
            if (updatedAt > latestTime) {
              latestTime = updatedAt;
              latest = profile;
            }
          }
          this.sellerProfile = latest;
          console.log(`[DEBUG] MessageServer: Loaded ${profiles.size} seller profile(s) from MongoDB, current: ${this.sellerProfile?.username}`);
          return;
        }
      } catch (error) {
        console.log(`[WARNING] MessageServer: MongoDB load failed, falling back to file: ${error.message}`);
      }
    }
    
    // Fallback: JSON file
    try {
      if (fs.existsSync(this.sellerProfilesPath)) {
        const data = JSON.parse(fs.readFileSync(this.sellerProfilesPath, 'utf-8'));
        const profiles = new Map();
        
        if (typeof data === 'object' && data !== null) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'object' && value !== null && value.username) {
              profiles.set(value.username, value);
            }
          }
        }
        
        if (profiles.size > 0) {
          this.sellerProfiles = profiles;
          // Get most recent profile
          let latest = null;
          let latestTime = '';
          for (const profile of profiles.values()) {
            const updatedAt = profile.updated_at || '';
            if (updatedAt > latestTime) {
              latestTime = updatedAt;
              latest = profile;
            }
          }
          this.sellerProfile = latest;
          console.log(`[DEBUG] MessageServer: Loaded ${profiles.size} seller profile(s) from file, current: ${this.sellerProfile?.username}`);
        } else {
          this.sellerProfile = null;
        }
      } else {
        // Try legacy seller_profile.json
        const legacyPath = path.join(__dirname, 'seller_profile.json');
        if (fs.existsSync(legacyPath)) {
          const single = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
          if (typeof single === 'object' && single !== null && single.username) {
            const username = single.username;
            this.sellerProfiles.set(username, single);
            this.sellerProfile = single;
            console.log(`[DEBUG] MessageServer: Migrated legacy seller_profile.json, username=${username}`);
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
      console.log(`[WARNING] MessageServer: Could not load seller profiles: ${error.message}`);
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
            { upsert: true }
          );
        }
        console.log(`[DEBUG] MessageServer: Saved ${this.sellerProfiles.size} seller profile(s) to MongoDB`);
      } catch (error) {
        console.log(`[ERROR] MessageServer: Could not save seller profiles to MongoDB: ${error.message}`);
      }
    }
    
    // Save to JSON file
    try {
      const data = Object.fromEntries(this.sellerProfiles);
      fs.writeFileSync(this.sellerProfilesPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[DEBUG] MessageServer: Saved ${this.sellerProfiles.size} seller profile(s) to ${this.sellerProfilesPath}`);
    } catch (error) {
      if (!this.mongodbUrl) {
        console.log(`[ERROR] MessageServer: Could not save seller_profiles.json: ${error.message}`);
      }
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
    
    const conversationId = data.conversationId;
    const messages = data.messages || [];
    if (!conversationId && messages.length === 0) {
      return;
    }
    
    try {
      const coll = db.collection(this.mongoMessagesColl);
      const clients = data.clients || [];
      const docId = conversationId ||
        (clients[0]?.conversationId) ||
        (clients[0]?.username) ||
        `conv_${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}`;
      
      const payload = { ...data };
      delete payload._id;
      payload.updated_at = new Date().toISOString();
      
      await coll.replaceOne(
        { _id: docId },
        { ...payload, _id: docId },
        { upsert: true }
      );
      
      console.log(`[DEBUG] MessageServer: Saved messages to MongoDB (conversationId=${conversationId}, count=${messages.length})`);
    } catch (error) {
      console.log(`[ERROR] MessageServer: Could not save messages to MongoDB: ${error.message}`);
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
    
    const key = data.username || data.conversationId || null;
    if (!key) {
      return;
    }
    
    try {
      const coll = db.collection(this.mongoClientsColl);
      const payload = { ...data };
      delete payload._id;
      payload.updated_at = new Date().toISOString();
      
      await coll.replaceOne(
        { _id: key },
        { ...payload, _id: key },
        { upsert: true }
      );
      
      console.log(`[DEBUG] MessageServer: Saved client data to MongoDB (key=${key})`);
    } catch (error) {
      console.log(`[ERROR] MessageServer: Could not save client data to MongoDB: ${error.message}`);
    }
  }
  
  /**
   * Save client list to MongoDB
   */
  async saveClientListToMongo(data) {
    const db = await this.getMongoDb();
    if (!db) {
      return;
    }
    
    const clients = data.clients || [];
    try {
      const coll = db.collection(this.mongoClientsColl);
      const payload = {
        clients: clients,
        updated_at: new Date().toISOString()
      };
      
      await coll.replaceOne(
        { _id: 'client_list' },
        { ...payload, _id: 'client_list' },
        { upsert: true }
      );
      
      console.log(`[DEBUG] MessageServer: Saved client list to MongoDB (count=${clients.length})`);
    } catch (error) {
      console.log(`[ERROR] MessageServer: Could not save client list to MongoDB: ${error.message}`);
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
    return Array.from(this.sellerProfiles.values()).map(profile => ({
      ...profile,
      online: online.has(profile.username)
    }));
  }
  
  /**
   * Handle message received
   */
  onMessageReceived(data) {
    console.log(`[DEBUG] MessageServer: _on_message_received() called with data`);
    console.log(`[DEBUG] MessageServer: Message count: ${(data.messages || []).length}`);
    
    // Store data
    this.storedMessageData = JSON.parse(JSON.stringify(data));
    
    // Save to MongoDB
    this.saveMessagesToMongo(data).catch(err => {
      console.log(`[WARNING] MessageServer: Error saving messages to MongoDB: ${err.message}`);
    });
    
    // Emit event
    this.emit('message_received', data);
    
    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: 'message_data',
      data: data
    });
    
    console.log(`[DEBUG] MessageServer: Signal emitted and data stored`);
  }
  
  /**
   * Handle client data received
   */
  onClientDataReceived(data) {
    console.log(`[DEBUG] MessageServer: _on_client_data_received() called with data`);
    
    // Store data
    const key = data.username || data.conversationId || 'default';
    this.storedClientData.set(key, JSON.parse(JSON.stringify(data)));
    
    // Save to MongoDB
    this.saveClientDataToMongo(data).catch(err => {
      console.log(`[WARNING] MessageServer: Error saving client data to MongoDB: ${err.message}`);
    });
    
    // Emit event
    this.emit('client_data_received', data);
    
    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: 'client_data',
      data: data
    });
    
    console.log(`[DEBUG] MessageServer: Client data signal emitted and data stored`);
  }
  
  /**
   * Handle client list received
   */
  onClientListReceived(data) {
    console.log(`[DEBUG] MessageServer: _on_client_list_received() called with data`);
    console.log(`[DEBUG] MessageServer: Client list count: ${(data.clients || []).length}`);
    
    // Store data
    this.storedClientList = JSON.parse(JSON.stringify(data));
    
    // Save to MongoDB
    this.saveClientListToMongo(data).catch(err => {
      console.log(`[WARNING] MessageServer: Error saving client list to MongoDB: ${err.message}`);
    });
    
    // Emit event
    this.emit('client_list_received', data);
    
    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: 'client_list_data',
      data: data
    });
    
    console.log(`[DEBUG] MessageServer: Client list signal emitted and data stored`);
  }
  
  /**
   * Handle new message detected
   */
  onNewMessageDetected(data) {
    console.log(`[DEBUG] MessageServer: _on_new_message_detected() called with data`);
    
    // Store data
    this.storedNewMessages.push(JSON.parse(JSON.stringify(data)));
    if (this.storedNewMessages.length > 100) {
      this.storedNewMessages.shift();
    }
    
    // Emit event
    this.emit('new_message_detected', data);
    
    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: 'new_message_detected',
      data: data
    });
    
    console.log(`[DEBUG] MessageServer: New message detection signal emitted and data stored`);
  }
  
  /**
   * Handle client activated
   */
  onClientActivated(username) {
    console.log(`[DEBUG] MessageServer: _on_client_activated() called with username: ${username}`);
    
    // Store data
    if (!this.storedClientActivations.includes(username)) {
      this.storedClientActivations.push(username);
      if (this.storedClientActivations.length > 100) {
        this.storedClientActivations.shift();
      }
    }
    
    // Emit event
    this.emit('client_activated', username);
    
    // Broadcast to Expo clients
    this.broadcastToExpoClients({
      type: 'client_activated',
      data: { username: username }
    });
    
    console.log(`[DEBUG] MessageServer: Client activated signal emitted and data stored`);
  }
  
  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws, req) {
    console.log(`[DEBUG] MessageServer: New WebSocket connection established`);
    
    // Store session info on websocket object
    ws._sessionId = null;
    ws._clientType = 'browser';
    
    // Set up message handler
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(`[DEBUG] MessageServer: Received WebSocket message: ${data.type || 'unknown'}`);
        await this.handleMessage(data, ws);
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.log(`[ERROR] MessageServer: Invalid JSON from client: ${error.message}`);
          console.log(`[ERROR] MessageServer: Raw message: ${message.toString().substring(0, 100)}`);
        } else {
          console.log(`[ERROR] MessageServer: Error handling message: ${error.message}`);
          console.error(error);
        }
      }
    });
    
    ws.on('close', () => {
      const sessionId = ws._sessionId;
      console.log(`[DEBUG] MessageServer: WebSocket client disconnected: ${sessionId}`);
      
      // Clean up connection
      const needBroadcastOnline = sessionId && this.browserProfileBySession.has(sessionId);
      
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
          type: 'seller_profiles',
          data: this.getSellerProfilesWithOnline()
        });
        
        if (this.sellerProfile) {
          const online = this.getOnlineUsernames();
          this.broadcastToExpoClients({
            type: 'seller_profile',
            data: { ...this.sellerProfile, online: online.has(this.sellerProfile.username) }
          });
        }
      }
      
      console.log(`[DEBUG] MessageServer: Cleaned up connection for session: ${sessionId}`);
    });
    
    ws.on('error', (error) => {
      console.log(`[ERROR] MessageServer: WebSocket error: ${error.message}`);
    });
  }
  
  /**
   * Handle incoming message from WebSocket client
   */
  async handleMessage(data, ws) {
    const msgType = data.type;
    const sessionId = ws._sessionId;
    console.log(`[DEBUG] MessageServer: Received message type=${msgType} from session=${sessionId || 'not connected yet'}`);
    
    // If not connected yet and message is not 'connect', wait for connect message
    if (!sessionId && msgType !== 'connect') {
      console.log(`[WARNING] MessageServer: Received ${msgType} message before connect, waiting for connect message...`);
      // Send error response
      try {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Please send connect message first'
        }));
      } catch (error) {
        console.log(`[ERROR] MessageServer: Error sending error response: ${error.message}`);
      }
      return;
    }
    
    if (msgType === 'connect') {
      const newSessionId = data.session_id || generateSessionId(this);
      const clientType = data.client_type || 'browser';
      
      console.log(`[DEBUG] MessageServer: Processing connect message - session_id: ${newSessionId}, client_type: ${clientType}`);
      
      // Store on websocket object
      ws._sessionId = newSessionId;
      ws._clientType = clientType;
      
      this.connectedClients.set(newSessionId, ws);
      this.clientSessions.set(ws, newSessionId);
      this.clientTypes.set(newSessionId, clientType);
      
      console.log(`[DEBUG] MessageServer: WebSocket client connected: ${newSessionId} (type: ${clientType})`);
      console.log(`[DEBUG] MessageServer: Total connected clients: ${this.connectedClients.size}`);
      
      // Send connection confirmation
      try {
        const confirmMessage = JSON.stringify({
          type: 'connected',
          session_id: newSessionId,
          status: 'ok'
        });
        ws.send(confirmMessage);
        console.log(`[DEBUG] MessageServer: Sent connection confirmation to ${newSessionId}`);
      } catch (error) {
        console.log(`[ERROR] MessageServer: Error sending connection confirmation: ${error.message}`);
      }
      
      // Send stored data based on client type
      if (clientType === 'expo') {
        await this.sendStoredDataToExpo(ws);
      } else if (clientType === 'desktop') {
        await this.sendPendingCommands(newSessionId, ws);
        if (this.sellerProfile) {
          const online = this.getOnlineUsernames();
          ws.send(JSON.stringify({
            type: 'seller_profile',
            data: { ...this.sellerProfile, online: online.has(this.sellerProfile.username) }
          }));
        }
        if (this.sellerProfiles.size > 0) {
          ws.send(JSON.stringify({
            type: 'seller_profiles',
            data: this.getSellerProfilesWithOnline()
          }));
        }
      } else {
        // Browser extension
        await this.sendPendingCommands(newSessionId, ws);
      }
      
    } else if (msgType === 'message_data') {
      const messageData = data.data || data;
      console.log(`[DEBUG] MessageServer: Received message data via WebSocket`);
      this.onMessageReceived(messageData);
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Data received'
      }));
      
    } else if (msgType === 'client_data') {
      const clientData = data.data || data;
      console.log(`[DEBUG] MessageServer: Received client data via WebSocket`);
      this.onClientDataReceived(clientData);
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Client data received'
      }));
      
    } else if (msgType === 'client_list_data') {
      const clientListData = data.data || data;
      console.log(`[DEBUG] MessageServer: Received client list data via WebSocket`);
      this.onClientListReceived(clientListData);
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Client list data received'
      }));
      
    } else if (msgType === 'new_message_detected') {
      const newMessageData = data.data || data;
      console.log(`[DEBUG] MessageServer: Received new message detection notification`);
      this.onNewMessageDetected(newMessageData);
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'New message detection received'
      }));
      
    } else if (msgType === 'client_activated') {
      const clientData = data.data || data;
      const username = typeof clientData === 'object' ? clientData.username : data.username;
      console.log(`[DEBUG] MessageServer: Received client activated notification: ${username}`);
      
      if (username) {
        this.onClientActivated(username);
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Client activated notification received'
      }));
      
    } else if (msgType === 'seller_profile') {
      console.log(`[DEBUG] MessageServer: Received seller_profile via WebSocket`, data);
      const profileName = (data.profileName || data.profile_name || '').trim();
      let username = (data.username || '').trim();
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
          updated_at: new Date().toISOString()
        };
        
        this.sellerProfiles.set(username, entry);
        this.sellerProfile = entry;
        await this.saveSellerProfiles();
        
        // Track browser session as online
        const currentSessionId = ws._sessionId;
        if (currentSessionId && this.clientTypes.get(currentSessionId) === 'browser') {
          this.browserProfileBySession.set(currentSessionId, username);
        }
        
        const online = this.getOnlineUsernames();
        const currentWithOnline = { ...this.sellerProfile, online: online.has(username) };
        const profilesWithOnline = this.getSellerProfilesWithOnline();
        
        // Broadcast to Expo/desktop
        this.broadcastToExpoClients({
          type: 'seller_profile',
          data: currentWithOnline
        });
        this.broadcastToExpoClients({
          type: 'seller_profiles',
          data: profilesWithOnline
        });
        
        // Send to desktop clients
        for (const [sid, desktopWs] of this.connectedClients.entries()) {
          if (this.clientTypes.get(sid) === 'desktop') {
            try {
              desktopWs.send(JSON.stringify({ type: 'seller_profile', data: currentWithOnline }));
              desktopWs.send(JSON.stringify({ type: 'seller_profiles', data: profilesWithOnline }));
            } catch (error) {
              console.log(`[WARNING] MessageServer: Error sending seller_profile to desktop ${sid}: ${error.message}`);
            }
          }
        }
        
        console.log(`[DEBUG] MessageServer: Seller profile saved: username=${username}, total profiles=${this.sellerProfiles.size}, online=${online.has(username)}`);
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Seller profile received and saved'
      }));
      
    } else if (msgType === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      
    } else if (msgType === 'request_all_data') {
      console.log(`[DEBUG] MessageServer: Expo client requesting all stored data`);
      await this.sendStoredDataToExpo(ws);
      
    } else if (msgType === 'request_client_list') {
      if (this.storedClientList) {
        ws.send(JSON.stringify({
          type: 'client_list_data',
          data: this.storedClientList
        }));
      }
      
    } else if (msgType === 'request_messages') {
      if (this.storedMessageData) {
        ws.send(JSON.stringify({
          type: 'message_data',
          data: this.storedMessageData
        }));
      }
      
    } else if (msgType === 'request_client_data') {
      const clientKey = data.username || data.conversationId;
      if (clientKey && this.storedClientData.has(clientKey)) {
        ws.send(JSON.stringify({
          type: 'client_data',
          data: this.storedClientData.get(clientKey)
        }));
      }
      
    } else if (msgType === 'trigger') {
      const action = data.action;
      console.log(`[DEBUG] MessageServer: Expo client requesting trigger: ${action}`);
      
      const command = {
        type: 'trigger',
        action: action
      };
      
      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries())
        .filter(([sid]) => this.clientTypes.get(sid) === 'browser');
      
      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: 'commands',
          commands: [command]
        });
        
        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
            console.log(`[DEBUG] MessageServer: Trigger command forwarded to browser client`);
          } catch (error) {
            console.log(`[WARNING] MessageServer: Error forwarding trigger to browser client: ${error.message}`);
          }
        }
      } else {
        console.log(`[WARNING] MessageServer: No browser extension clients connected to forward trigger`);
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: `Trigger command sent: ${action}`
      }));
      
    } else if (msgType === 'click_client' || msgType === 'clickFirstClient') {
      const username = data.username;
      const useFirstClient = data.useFirstClient || msgType === 'clickFirstClient';
      
      console.log(`[DEBUG] MessageServer: Expo client requesting to click client: username=${username}, use_first_client=${useFirstClient}`);
      
      let command;
      if (useFirstClient) {
        command = { type: 'clickFirstClient' };
      } else {
        if (!username) {
          ws.send(JSON.stringify({
            type: 'ack',
            status: 'error',
            message: 'Username is required for click_client command'
          }));
          return;
        }
        command = {
          type: 'click_client',
          username: username,
          useFirstClient: false
        };
      }
      
      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries())
        .filter(([sid]) => this.clientTypes.get(sid) === 'browser');
      
      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: 'commands',
          commands: [command]
        });
        
        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
            console.log(`[DEBUG] MessageServer: Click client command forwarded to browser client`);
          } catch (error) {
            console.log(`[WARNING] MessageServer: Error forwarding click_client to browser client: ${error.message}`);
          }
        }
      } else {
        console.log(`[WARNING] MessageServer: No browser extension clients connected to forward click_client`);
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: `Click client command sent: ${username || 'first client'}`
      }));
      
    } else if (msgType === 'send_message') {
      const messageText = data.message;
      const conversationId = data.conversationId;
      
      if (!messageText || !messageText.trim()) {
        ws.send(JSON.stringify({
          type: 'ack',
          status: 'error',
          message: 'Message text is required'
        }));
        return;
      }
      
      console.log(`[DEBUG] MessageServer: Expo client requesting to send message: ${messageText.substring(0, 50)}...`);
      
      const command = {
        type: 'send_message',
        message: messageText.trim()
      };
      
      // Forward to browser extension clients
      const browserClients = Array.from(this.connectedClients.entries())
        .filter(([sid]) => this.clientTypes.get(sid) === 'browser');
      
      if (browserClients.length > 0) {
        const message = JSON.stringify({
          type: 'commands',
          commands: [command]
        });
        
        for (const [, browserWs] of browserClients) {
          try {
            browserWs.send(message);
            console.log(`[DEBUG] MessageServer: Send message command forwarded to browser client`);
          } catch (error) {
            console.log(`[WARNING] MessageServer: Error forwarding send_message to browser client: ${error.message}`);
          }
        }
      } else {
        console.log(`[WARNING] MessageServer: No browser extension clients connected to forward send_message`);
        this.pendingSendMessage = messageText.trim();
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Send message command sent to browser extension'
      }));
      
    } else if (msgType === 'fetch_client_details') {
      const username = data.username;
      if (!username) {
        ws.send(JSON.stringify({
          type: 'ack',
          status: 'error',
          message: 'Username is required for fetch_client_details'
        }));
        return;
      }
      
      console.log(`[DEBUG] MessageServer: Expo client requesting to fetch client details for username: ${username}`);
      
      if (this.connectedClients.size === 0) {
        ws.send(JSON.stringify({
          type: 'ack',
          status: 'error',
          message: 'Browser extension is not connected. Please open a Fiverr tab and ensure the extension is enabled.'
        }));
        return;
      }
      
      try {
        const profileUrl = `https://www.fiverr.com/${username}`;
        console.log(`[DEBUG] MessageServer: Navigating to profile URL: ${profileUrl}`);
        
        if (!this.navigateToUrl(profileUrl)) {
          ws.send(JSON.stringify({
            type: 'ack',
            status: 'error',
            message: 'Failed to send navigate command to browser extension'
          }));
          return;
        }
        
        ws.send(JSON.stringify({
          type: 'ack',
          status: 'success',
          message: `Navigating to ${username}'s profile. Extraction will start shortly...`
        }));
        
        // Wait 5 seconds then trigger extraction
        setTimeout(() => {
          console.log(`[DEBUG] MessageServer: Triggering client data extraction...`);
          this.triggerClientExtraction();
        }, 5000);
        
      } catch (error) {
        console.log(`[ERROR] MessageServer: Error fetching client details: ${error.message}`);
        console.error(error);
        ws.send(JSON.stringify({
          type: 'ack',
          status: 'error',
          message: `Error fetching client details: ${error.message}`
        }));
      }
      
    } else if (msgType === 'command_status') {
      const commandType = data.commandType;
      const status = data.status || 'unknown';
      const message = data.message || '';
      const error = data.error;
      
      if (status === 'success') {
        console.log(`[SUCCESS] MessageServer: Command '${commandType}' executed successfully`);
      } else if (status === 'warning') {
        if (message.toLowerCase().includes('content script') || message.toLowerCase().includes('not ready')) {
          console.log(`[DEBUG] MessageServer: Content script readiness warning (expected): ${message}`);
        } else {
          console.log(`[WARNING] MessageServer: Command '${commandType}' warning: ${message}`);
        }
      } else if (status === 'error') {
        console.log(`[ERROR] MessageServer: Command '${commandType}' failed: ${message}`);
        if (error) {
          console.log(`[ERROR] MessageServer: Error details: ${error}`);
        }
      } else {
        console.log(`[DEBUG] MessageServer: Command '${commandType}' status: ${status} - ${message}`);
      }
      
      ws.send(JSON.stringify({
        type: 'ack',
        status: 'success',
        message: 'Command status received'
      }));
      
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
    const snapshotMessage = this.storedMessageData ? JSON.parse(JSON.stringify(this.storedMessageData)) : null;
    const snapshotClientList = this.storedClientList ? JSON.parse(JSON.stringify(this.storedClientList)) : null;
    const snapshotClientData = new Map();
    for (const [key, value] of this.storedClientData.entries()) {
      snapshotClientData.set(key, JSON.parse(JSON.stringify(value)));
    }
    const snapshotNewMessages = this.storedNewMessages.slice(-10);
    const snapshotActivations = this.storedClientActivations.slice(-10);
    const snapshotSellerProfile = this.sellerProfile ? JSON.parse(JSON.stringify(this.sellerProfile)) : null;
    const online = this.getOnlineUsernames();
    const snapshotSellerProfiles = Array.from(this.sellerProfiles.values()).map(p => ({
      ...JSON.parse(JSON.stringify(p)),
      online: online.has(p.username)
    }));
    
    // Send data
    try {
      if (snapshotMessage) {
        ws.send(JSON.stringify({ type: 'message_data', data: snapshotMessage }));
        console.log(`[DEBUG] MessageServer: Sent stored message data to Expo client`);
      }
      
      if (snapshotClientList) {
        ws.send(JSON.stringify({ type: 'client_list_data', data: snapshotClientList }));
        console.log(`[DEBUG] MessageServer: Sent stored client list to Expo client`);
      }
      
      for (const [, clientData] of snapshotClientData.entries()) {
        ws.send(JSON.stringify({ type: 'client_data', data: clientData }));
      }
      
      for (const newMsg of snapshotNewMessages) {
        ws.send(JSON.stringify({ type: 'new_message_detected', data: newMsg }));
      }
      
      for (const username of snapshotActivations) {
        ws.send(JSON.stringify({ type: 'client_activated', data: { username } }));
      }
      
      if (snapshotSellerProfile) {
        const currentWithOnline = { ...snapshotSellerProfile, online: online.has(snapshotSellerProfile.username) };
        ws.send(JSON.stringify({ type: 'seller_profile', data: currentWithOnline }));
        console.log(`[DEBUG] MessageServer: Sent stored seller profile to Expo client`);
      }
      
      if (snapshotSellerProfiles.length > 0) {
        ws.send(JSON.stringify({ type: 'seller_profiles', data: snapshotSellerProfiles }));
        console.log(`[DEBUG] MessageServer: Sent ${snapshotSellerProfiles.length} seller profile(s) to Expo client`);
      }
      
      // Notify sync complete
      ws.send(JSON.stringify({
        type: 'sync_complete',
        status: 'ok',
        message: 'All stored data sent'
      }));
      console.log(`[DEBUG] MessageServer: Stored data sync complete for Expo client`);
    } catch (error) {
      console.log(`[WARNING] MessageServer: Could not send sync_complete to Expo: ${error.message}`);
    }
  }
  
  /**
   * Send pending commands to client
   */
  async sendPendingCommands(sessionId, ws) {
    const commands = [];
    
    if (this.pendingTrigger) {
      commands.push({
        type: 'trigger',
        action: 'extract_messages'
      });
      this.pendingTrigger = false;
    }
    
    if (this.pendingClientTrigger) {
      commands.push({
        type: 'trigger',
        action: 'extract_client_data'
      });
      this.pendingClientTrigger = false;
    }
    
    if (this.pendingClientListTrigger) {
      commands.push({
        type: 'trigger',
        action: 'extract_client_list'
      });
      this.pendingClientListTrigger = false;
    }
    
    if (this.pendingSendMessage) {
      commands.push({
        type: 'send_message',
        message: this.pendingSendMessage
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
      ws.send(JSON.stringify({
        type: 'commands',
        commands: commands
      }));
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
      if (this.clientTypes.get(sessionId) === 'expo') {
        try {
          ws.send(messageJson);
        } catch (error) {
          console.log(`[WARNING] MessageServer: Error broadcasting to Expo client ${sessionId}: ${error.message}`);
          disconnected.push(sessionId);
        }
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
   * Broadcast command to all clients
   */
  async broadcastCommand(command) {
    if (this.connectedClients.size === 0) {
      return;
    }
    
    const message = JSON.stringify({
      type: 'commands',
      commands: [command]
    });
    
    const disconnected = [];
    for (const [sessionId, ws] of this.connectedClients.entries()) {
      try {
        ws.send(message);
      } catch (error) {
        console.log(`[WARNING] MessageServer: Error sending to client ${sessionId}: ${error.message}`);
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
      if (upgrade && upgrade.toLowerCase() === 'websocket') {
        // WebSocketServer will handle this, but we can log it
        console.log(`[DEBUG] MessageServer: WebSocket upgrade request detected for ${req.url}`);
        // Don't respond here - let WebSocketServer handle it
        return;
      }
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;
      
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      // Health check endpoints
      if (pathname === '/' || pathname === '/health' || pathname === '/healthz') {
        const isRender = process.env.RENDER === 'true';
        let wsUrl;
        
        if (isRender) {
          const renderServiceUrl = process.env.RENDER_EXTERNAL_URL ||
            process.env.RENDER_SERVICE_URL ||
            'https://fiverr-agent-03vs.onrender.com';
          wsUrl = renderServiceUrl.replace('https://', 'wss://').replace('http://', 'ws://').replace(/\/$/, '');
        } else {
          wsUrl = `ws://127.0.0.1:${this.port}`;
        }
        
        const body = JSON.stringify({
          status: 'ok',
          message: 'MessageServer is running',
          ws: wsUrl
        });
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
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
      console.log(`[DEBUG] MessageServer: Server already running on port ${this.port}`);
      return;
    }
    
    this.running = true;
    
    // Create HTTP server
    this.httpServer = this.createHttpServer();
    
    // Create WebSocket server (no path restriction - accepts all WebSocket connections)
    this.wss = new WebSocketServer({
      server: this.httpServer,
      perMessageDeflate: false,
      clientTracking: true
    });
    
    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      console.log(`[DEBUG] MessageServer: WebSocket connection attempt from ${clientIp}`);
      console.log(`[DEBUG] MessageServer: User-Agent: ${userAgent.substring(0, 100)}`);
      console.log(`[DEBUG] MessageServer: Request URL: ${req.url}`);
      this.handleWebSocketConnection(ws, req);
    });
    
    this.wss.on('error', (error) => {
      console.log(`[ERROR] MessageServer: WebSocket server error: ${error.message}`);
      console.error(error);
    });
    
    this.wss.on('headers', (headers, req) => {
      // Log WebSocket handshake headers for debugging
      console.log(`[DEBUG] MessageServer: WebSocket handshake headers:`, {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        'sec-websocket-key': req.headers['sec-websocket-key'] ? 'present' : 'missing'
      });
    });
    
    // Start listening
    this.httpServer.listen(this.port, '0.0.0.0', () => {
      console.log(`[SUCCESS] MessageServer: ========================================`);
      console.log(`[SUCCESS] MessageServer: WebSocket server started successfully!`);
      console.log(`[SUCCESS] MessageServer: Port: ${this.port}`);
      console.log(`[SUCCESS] MessageServer: URL: ws://0.0.0.0:${this.port}`);
      console.log(`[SUCCESS] MessageServer: Health: http://localhost:${this.port}/health`);
      console.log(`[SUCCESS] MessageServer: ========================================`);
    });
    
    this.httpServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.log(`[ERROR] MessageServer: Port ${this.port} is already in use!`);
        console.log(`[ERROR] MessageServer: This usually means another instance is running`);
      } else {
        console.log(`[ERROR] MessageServer: HTTP server error: ${error.message}`);
      }
      this.running = false;
    });
  }
  
  /**
   * Stop the server
   */
  stop() {
    console.log(`[DEBUG] MessageServer: stop() called, running=${this.running}`);
    
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
      type: 'trigger',
      action: 'extract_messages'
    };
    
    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Trigger command sent via WebSocket`);
    } else {
      this.pendingTrigger = true;
      console.log(`[DEBUG] MessageServer: No clients connected, trigger queued`);
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
      type: 'trigger',
      action: 'extract_client_data'
    };
    
    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Client trigger command sent via WebSocket`);
    } else {
      this.pendingClientTrigger = true;
      console.log(`[DEBUG] MessageServer: No clients connected, trigger queued`);
    }
    
    return true;
  }
  
  /**
   * Trigger client list extraction
   */
  triggerClientListExtraction() {
    console.log(`[DEBUG] MessageServer: trigger_client_list_extraction() called`);
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }
    
    const command = {
      type: 'trigger',
      action: 'extract_client_list'
    };
    
    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Client list trigger command sent via WebSocket`);
    } else {
      this.pendingClientListTrigger = true;
      console.log(`[DEBUG] MessageServer: No clients connected, trigger queued`);
    }
    
    return true;
  }
  
  /**
   * Send message to client
   */
  sendMessageToClient(messageText) {
    console.log(`[DEBUG] MessageServer: send_message_to_client() called with message: ${messageText.substring(0, 50)}...`);
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }
    
    const command = {
      type: 'send_message',
      message: messageText
    };
    
    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Send message command sent via WebSocket`);
    } else {
      this.pendingSendMessage = messageText;
      console.log(`[DEBUG] MessageServer: No clients connected, message queued`);
    }
    
    return true;
  }
  
  /**
   * Click client in Fiverr
   */
  clickClientInFiverr(username = null, useFirstClient = false) {
    if (useFirstClient) {
      console.log(`[DEBUG] MessageServer: click_client_in_fiverr() called with use_first_client=True`);
      const command = { type: 'clickFirstClient' };
      
      if (!this.running) {
        console.log(`[ERROR] MessageServer: Server is not running`);
        return false;
      }
      
      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);
        console.log(`[DEBUG] MessageServer: Click client command sent via WebSocket`);
        return true;
      } else {
        this.pendingClickCommands.push(command);
        console.log(`[WARNING] MessageServer: No clients connected, click command queued`);
        return false;
      }
    } else {
      console.log(`[DEBUG] MessageServer: click_client_in_fiverr() called with username: ${username}`);
      if (!username) {
        console.log(`[ERROR] MessageServer: Username is required for click_client command when use_first_client is False`);
        return false;
      }
      
      const command = {
        type: 'click_client',
        username: username,
        useFirstClient: false
      };
      
      if (!this.running) {
        console.log(`[ERROR] MessageServer: Server is not running`);
        return false;
      }
      
      if (this.connectedClients.size > 0) {
        this.broadcastCommand(command);
        console.log(`[DEBUG] MessageServer: Click client command sent via WebSocket`);
        return true;
      } else {
        this.pendingClickCommands.push(command);
        console.log(`[WARNING] MessageServer: No clients connected, click command queued`);
        return false;
      }
    }
  }
  
  /**
   * Navigate to URL
   */
  navigateToUrl(url) {
    console.log(`[DEBUG] MessageServer: navigate_to_url() called with url: ${url}`);
    if (!this.running) {
      console.log(`[ERROR] MessageServer: Server is not running`);
      return false;
    }
    
    const command = {
      type: 'navigate',
      url: url
    };
    
    if (this.connectedClients.size > 0) {
      this.broadcastCommand(command);
      console.log(`[DEBUG] MessageServer: Navigate command sent via WebSocket`);
    } else {
      console.log(`[WARNING] MessageServer: No clients connected, navigate command not sent`);
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
      [Symbol.iterator]: () => this.connectedClients.keys()
    };
  }
}
