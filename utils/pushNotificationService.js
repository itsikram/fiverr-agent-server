/**
 * Push Notification Service
 * - Expo Push for native apps
 * - Web Push (VAPID) for Expo web / PWA (works when the browser/app is closed)
 */
import { Expo } from 'expo-server-sdk';
import webpush from 'web-push';

const DEFAULT_VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:admin@fiverr-agent.local';

class PushNotificationService {
  constructor() {
    this.expo = new Expo();
    this.vapidConfigured = false;
    this.configureVapidFromEnv();
  }

  configureVapidFromEnv() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
      this.vapidConfigured = false;
      return false;
    }

    try {
      webpush.setVapidDetails(DEFAULT_VAPID_SUBJECT, publicKey, privateKey);
      this.vapidPublicKey = publicKey;
      this.vapidConfigured = true;
      return true;
    } catch (error) {
      this.vapidConfigured = false;
      return false;
    }
  }

  ensureVapidConfigured() {
    if (this.vapidConfigured) return true;
    return this.configureVapidFromEnv();
  }

  getVapidPublicKey() {
    this.ensureVapidConfigured();
    return this.vapidPublicKey || process.env.VAPID_PUBLIC_KEY || null;
  }

  isExpoPushToken(token) {
    if (!token) return false;
    return Expo.isExpoPushToken(token);
  }

  isWebPushSubscription(subscription) {
    return Boolean(
      subscription &&
        typeof subscription === 'object' &&
        subscription.endpoint &&
        subscription.keys?.p256dh &&
        subscription.keys?.auth
    );
  }

  async sendExpoPush(pushToken, { title, body, data = {} }) {
    if (!this.isExpoPushToken(pushToken)) {
      return { success: false, error: 'Invalid Expo push token' };
    }

    const message = {
      to: pushToken,
      sound: 'default',
      title: title || 'New Message',
      body: body || 'You have a new message',
      data: {
        ...data,
        type: data.type || 'new_message',
      },
      priority: 'high',
      channelId: 'messages',
    };

    const chunks = this.expo.chunkPushNotifications([message]);
    const tickets = [];

    for (const chunk of chunks) {
      const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }

    for (const ticket of tickets) {
      if (ticket.status === 'error') {
        return { success: false, error: ticket.message || 'Unknown error' };
      }
    }

    return { success: true, tickets, channel: 'expo' };
  }

  async sendWebPush(subscription, { title, body, data = {} }) {
    if (!this.ensureVapidConfigured()) {
      return {
        success: false,
        error:
          'Web Push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in server .env',
      };
    }

    if (!this.isWebPushSubscription(subscription)) {
      return { success: false, error: 'Invalid web push subscription' };
    }

    const payload = JSON.stringify({
      title: title || 'New Message',
      body: body || 'You have a new message',
      data: {
        ...data,
        type: data.type || 'new_message',
      },
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
    });

    try {
      await webpush.sendNotification(subscription, payload, {
        TTL: 60 * 60,
        urgency: 'high',
      });
      return { success: true, channel: 'web' };
    } catch (error) {
      const statusCode = error?.statusCode || error?.status;
      return {
        success: false,
        error: error?.message || 'Web push failed',
        statusCode,
        gone: statusCode === 404 || statusCode === 410,
      };
    }
  }

  /**
   * Send push notification to a single Expo device
   */
  async sendPushNotification(pushToken, { title, body, data = {} }) {
    try {
      return await this.sendExpoPush(pushToken, { title, body, data });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Send Expo push notifications to multiple devices
   */
  async sendPushNotifications(pushTokens, { title, body, data = {} }) {
    try {
      const validTokens = (pushTokens || []).filter((token) =>
        this.isExpoPushToken(token)
      );

      if (validTokens.length === 0) {
        return { success: false, error: 'No valid push tokens', sentCount: 0 };
      }

      const messages = validTokens.map((token) => ({
        to: token,
        sound: 'default',
        title: title || 'New Message',
        body: body || 'You have a new message',
        data: {
          ...data,
          type: data.type || 'new_message',
        },
        priority: 'high',
        channelId: 'messages',
      }));

      const chunks = this.expo.chunkPushNotifications(messages);
      const tickets = [];

      for (const chunk of chunks) {
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      }

      const errors = [];
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          errors.push(ticket.message || 'Unknown error');
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          error: errors.join(', '),
          sentCount: validTokens.length - errors.length,
        };
      }

      return { success: true, tickets, sentCount: validTokens.length };
    } catch (error) {
      return { success: false, error: error.message, sentCount: 0 };
    }
  }

  /**
   * Send to a mix of Expo tokens and web push subscriptions.
   * @returns {{ success: boolean, sentCount: number, goneEndpoints: string[], errors: string[] }}
   */
  async sendToTargets(targets = [], { title, body, data = {} }) {
    const goneEndpoints = [];
    const errors = [];
    let sentCount = 0;

    const expoTokens = [];
    const webSubs = [];

    for (const target of targets) {
      if (!target) continue;
      if (typeof target === 'string' && this.isExpoPushToken(target)) {
        expoTokens.push(target);
        continue;
      }
      if (target.type === 'expo' && target.token) {
        expoTokens.push(target.token);
        continue;
      }
      if (
        target.type === 'web' &&
        this.isWebPushSubscription(target.subscription)
      ) {
        webSubs.push(target.subscription);
        continue;
      }
      if (this.isWebPushSubscription(target)) {
        webSubs.push(target);
      }
    }

    if (expoTokens.length > 0) {
      const expoResult = await this.sendPushNotifications(expoTokens, {
        title,
        body,
        data,
      });
      if (expoResult.success) {
        sentCount += expoResult.sentCount || expoTokens.length;
      } else if (expoResult.error) {
        errors.push(expoResult.error);
      }
    }

    for (const subscription of webSubs) {
      const result = await this.sendWebPush(subscription, { title, body, data });
      if (result.success) {
        sentCount += 1;
      } else {
        if (result.gone) {
          goneEndpoints.push(subscription.endpoint);
        }
        if (result.error) errors.push(result.error);
      }
    }

    return {
      success: sentCount > 0,
      sentCount,
      goneEndpoints,
      errors,
    };
  }
}

export const pushNotificationService = new PushNotificationService();
export default pushNotificationService;
