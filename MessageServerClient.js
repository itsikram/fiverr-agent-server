/**
 * WebSocket client that connects to a live MessageServer (e.g. on Render).
 * Exposes the same events and key methods as MessageServer so the desktop UI can use either.
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { generateSessionId } from './utils/serverUtils.js';

// Convert HTTP/HTTPS URL to WebSocket URL (ws/wss)
const convertToWebSocketUrl = (url) => {
  if (!url || !url.trim()) return null;
  
  const u = url.trim();
  
  // If already a WebSocket URL, return as-is
  if (u.startsWith('ws://') || u.startsWith('wss://')) {
    return u.replace(/\/+$/, '');
  }
  
  // If it's a full HTTP/HTTPS URL, convert to WebSocket
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try {
      const urlObj = new URL(u);
      const protocol = urlObj.protocol === 'https:' ? 'wss' : 'ws';
      const port = urlObj.port ? `:${urlObj.port}` : '';
      return `${protocol}://${urlObj.hostname}${port}`;
    } catch (error) {
      console.error('[MessageServerClient] Error parsing URL:', error);
      return null;
    }
  }
  
  // If it's just a host, assume wss for remote servers
  return `wss://${u.split('/')[0]}`;
};

// Get default server URL from environment variables
const getDefaultServerUrl = () => {
  // Try SERVER_URL first (supports HTTP/HTTPS)
  if (process.env.SERVER_URL) {
    const wsUrl = convertToWebSocketUrl(process.env.SERVER_URL);
    if (wsUrl) return wsUrl;
  }
  
  // Try LIVE_SERVER_WS_URL (WebSocket URL)
  if (process.env.LIVE_SERVER_WS_URL) {
    return process.env.LIVE_SERVER_WS_URL.replace(/\/+$/, '');
  }
  
  // Default fallback
  return 'wss://fiverr-agent-03vs.onrender.com';
};

const DEFAULT_LIVE_SERVER_WS_URL = getDefaultServerUrl();

export class MessageServerClient extends EventEmitter {
  constructor(serverUrl = null) {
    super();
    // Convert HTTP/HTTPS URL to WebSocket URL if needed
    const urlToUse = serverUrl || DEFAULT_LIVE_SERVER_WS_URL;
    const convertedUrl = convertToWebSocketUrl(urlToUse);
    this.serverUrl = (convertedUrl || urlToUse).trim();
    this.running = false;
    this.ws = null;
    this.sessionId = null;
    this.reconnectTimeout = null;
    this.sendQueue = [];
    
    // Same storage shape as MessageServer for compatibility
    this.storedMessageData = null;
    this.storedClientData = new Map();
    this.storedClientList = null;
    this.storedNewMessages = [];
    this.storedClientActivations = [];
    this.storedSellerProfile = null;
    this.storedSellerProfiles = [];
    this.port = this.serverUrl.includes('wss') ? 443 : 8765;
  }
  
  /**
   * Get clients property (for compatibility)
   */
  get clients() {
    return {
      size: this.running && this.ws ? 1 : 0,
      has: () => this.running && this.ws !== null,
      [Symbol.iterator]: function* () {
        if (this.running && this.ws) {
          yield 'desktop';
        }
      }
    };
  }
  
  /**
   * Start the client
   */
  start() {
    if (this.running) {
      return;
    }
    
    this.running = true;
    this.connect();
  }
  
  /**
   * Stop the client
   */
  stop() {
    this.running = false;
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // Ignore
      }
      this.ws = null;
    }
  }
  
  /**
   * Connect to server
   */
  connect() {
    if (!this.running) {
      return;
    }
    
    console.log(`[DEBUG] MessageServerClient: Connecting to ${this.serverUrl}`);
    
    try {
      this.ws = new WebSocket(this.serverUrl, {
        handshakeTimeout: 25000
      });
      
      this.ws.on('open', () => {
        console.log(`[SUCCESS] MessageServerClient: Connected to live server`);
        
        // Send connection message
        this.sessionId = generateSessionId(this);
        this.send({
          type: 'connect',
          session_id: this.sessionId,
          client_type: 'desktop'
        });
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleServerMessage(message);
        } catch (error) {
          if (error instanceof SyntaxError) {
            // Ignore invalid JSON
          } else {
            console.log(`[ERROR] MessageServerClient: Error handling message: ${error.message}`);
          }
        }
      });
      
      this.ws.on('close', () => {
        console.log(`[DEBUG] MessageServerClient: Disconnected from server`);
        this.ws = null;
        
        // Reconnect if still running
        if (this.running) {
          this.reconnectTimeout = setTimeout(() => {
            this.connect();
          }, 2000);
        }
      });
      
      this.ws.on('error', (error) => {
        console.log(`[DEBUG] MessageServerClient: WebSocket error: ${error.message}`);
      });
      
    } catch (error) {
      console.log(`[ERROR] MessageServerClient: Connection error: ${error.message}`);
      if (this.running) {
        this.reconnectTimeout = setTimeout(() => {
          this.connect();
        }, 2000);
      }
    }
  }
  
  /**
   * Handle server message
   */
  handleServerMessage(data) {
    const msgType = data.type;
    
    if (msgType === 'message_data') {
      const payload = data.data || data;
      this.storedMessageData = typeof payload === 'object' ? { ...payload } : {};
      this.emit('message_received', payload);
      
    } else if (msgType === 'client_data') {
      const payload = data.data || data;
      if (typeof payload === 'object') {
        const key = payload.username || payload.conversationId || 'default';
        this.storedClientData.set(key, { ...payload });
        this.emit('client_data_received', payload);
        this.emit('client_details_scraped', payload);
      }
      
    } else if (msgType === 'client_list_data') {
      const payload = data.data || data;
      if (typeof payload === 'object') {
        this.storedClientList = { ...payload };
        this.emit('client_list_received', payload);
      }
      
    } else if (msgType === 'new_message_detected') {
      const payload = data.data || data;
      if (typeof payload === 'object') {
        this.storedNewMessages.push({ ...payload });
        if (this.storedNewMessages.length > 100) {
          this.storedNewMessages.shift();
        }
        this.emit('new_message_detected', payload);
      }
      
    } else if (msgType === 'client_activated') {
      const payload = data.data || data;
      const username = typeof payload === 'object' ? payload.username : data.username;
      if (username) {
        if (!this.storedClientActivations.includes(username)) {
          this.storedClientActivations.push(username);
          if (this.storedClientActivations.length > 100) {
            this.storedClientActivations.shift();
          }
        }
        this.emit('client_activated', username);
      }
      
    } else if (msgType === 'seller_profile') {
      const payload = data.data || data;
      if (typeof payload === 'object') {
        this.storedSellerProfile = { ...payload };
        console.log(`[DEBUG] MessageServerClient: Seller profile updated: username=${payload.username}, profileName=${payload.profileName}`);
      }
      
    } else if (msgType === 'seller_profiles') {
      const payload = data.data || data;
      if (Array.isArray(payload)) {
        this.storedSellerProfiles = [...payload];
        console.log(`[DEBUG] MessageServerClient: Seller profiles list updated: ${payload.length} profile(s)`);
      }
      
    } else if (msgType === 'connected') {
      console.log(`[DEBUG] MessageServerClient: Server confirmed session ${data.session_id}`);
    }
  }
  
  /**
   * Send message to server
   */
  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue message if not connected
      this.sendQueue.push(obj);
      return false;
    }
    
    try {
      // Send queued messages first
      while (this.sendQueue.length > 0) {
        const queued = this.sendQueue.shift();
        this.ws.send(JSON.stringify(queued));
      }
      
      // Send current message
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (error) {
      console.log(`[ERROR] MessageServerClient: Error sending message: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Check if client is running
   */
  isRunning() {
    return this.running && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  
  /**
   * Trigger message extraction
   */
  triggerExtraction() {
    return this.send({ type: 'trigger', action: 'extract_messages' });
  }
  
  /**
   * Trigger client data extraction
   */
  triggerClientExtraction() {
    return this.send({ type: 'trigger', action: 'extract_client_data' });
  }
  
  /**
   * Trigger client list extraction
   */
  triggerClientListExtraction() {
    return this.send({ type: 'trigger', action: 'extract_client_list' });
  }
  
  /**
   * Send message to client
   */
  sendMessageToClient(messageText) {
    if (!messageText || !String(messageText).trim()) {
      return false;
    }
    return this.send({ type: 'send_message', message: String(messageText).trim() });
  }
  
  /**
   * Click client in Fiverr
   */
  clickClientInFiverr(username = null, useFirstClient = false) {
    if (useFirstClient) {
      return this.send({ type: 'clickFirstClient' });
    }
    if (!username) {
      return false;
    }
    return this.send({ type: 'click_client', username: username, useFirstClient: false });
  }
  
  /**
   * Get current URL
   */
  getCurrentUrl() {
    return this.send({ type: 'get_current_url' }) || null;
  }
  
  /**
   * Navigate to URL
   */
  navigateToUrl(url) {
    if (!url) {
      return false;
    }
    return this.send({ type: 'navigate', url: url });
  }
  
  /**
   * Fetch client details by username
   */
  fetchClientDetailsByUsername(username) {
    if (!username) {
      return null;
    }
    this.send({ type: 'fetch_client_details', username: username });
    return null; // Result will come back via client_data_received / client_details_scraped
  }
}
