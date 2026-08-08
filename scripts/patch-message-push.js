import fs from 'fs';

const path = new URL('../MessageServer.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const oldCall = `    // Send push notifications to all registered tokens (works even when app is closed)
    /*
    this.sendPushNotificationForMessage(data).catch(() => {});
    */`;

const newCall = `    // Push to native + web PWA even when the app/tab is closed.
    this.sendPushNotificationForMessage(data).catch(() => {});`;

if (!src.includes(oldCall)) {
  console.error('old call block not found');
  process.exit(1);
}
src = src.replace(oldCall, newCall);

const startMarker =
  '  /**\n   * Send push notification for new message\n   * This works even when the app is completely closed\n   */\n  async sendPushNotificationForMessage(messageData) {';
const endMarker =
  '\n  /**\n   * Handle client activated\n   */\n  onClientActivated(username) {';

const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  console.error('function markers not found', { start, end });
  process.exit(1);
}

const replacement = `  getMessagePushDedupeKey(messageData = {}) {
    const conversationId =
      messageData.conversationId ||
      messageData.clientUsername ||
      messageData.username ||
      "unknown";
    const text = String(
      messageData.messageText || messageData.lastMessage || ""
    )
      .trim()
      .slice(0, 80);
    return \`\${String(conversationId).toLowerCase()}::\${text}\`;
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
      this.mongoPushSubscriptionsCollection = this.mongoDb.collection(
        "push_subscriptions"
      );
      try {
        await this.mongoPushSubscriptionsCollection.createIndex(
          { endpoint: 1 },
          { unique: true }
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
          registeredAt: row.registeredAt || Date.now()
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
            updatedAt: new Date()
          }
        },
        { upsert: true }
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
      isTest
    } = messageData;

    const targets = await this.getAllPushTargets();
    if (targets.length === 0) {
      return;
    }

    const title = isTest
      ? "Test Notification"
      : \`New message from \${clientName || "Client"}\`;
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
        isTest: isTest || false
      }
    });

    if (Array.isArray(result?.goneEndpoints)) {
      for (const endpoint of result.goneEndpoints) {
        await this.removeWebPushSubscription(endpoint);
      }
    }
  }
`;

src = src.slice(0, start) + replacement + src.slice(end);
fs.writeFileSync(path, src);
console.log('patched MessageServer push flow');
