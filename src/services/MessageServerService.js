import { MessageServer as LegacyMessageServer } from '../../MessageServer.js';

/**
 * MessageServerService - WebSocket handler wrapper
 * Temporarily wraps the legacy MessageServer for WebSocket handling
 */
export class MessageServer {
  constructor(port, httpServer) {
    this.port = port;
    this.httpServer = httpServer;
    
    // Initialize legacy message server
    this.legacy = new LegacyMessageServer(port);
  }

  handleWebSocketConnection(ws, req) {
    // Delegate to legacy message server
    if (this.legacy.handleWebSocketConnection) {
      return this.legacy.handleWebSocketConnection(ws, req);
    }
  }

  async start() {
    // Legacy server manages its own HTTP server
    // We'll start it separately if needed
  }

  async stop() {
    if (this.legacy && this.legacy.stop) {
      this.legacy.stop();
    }
  }
}
