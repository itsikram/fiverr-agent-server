/**
 * Push Notification Service
 * Handles sending push notifications via Expo Push Notification service
 */
import { Expo } from 'expo-server-sdk';

class PushNotificationService {
  constructor() {
    // Create a new Expo SDK client
    this.expo = new Expo();
  }

  /**
   * Validate if a token is a valid Expo push token
   * @param {string} token - Push token to validate
   * @returns {boolean} True if valid
   */
  isExpoPushToken(token) {
    if (!token) return false;
    return Expo.isExpoPushToken(token);
  }

  /**
   * Send push notification to a single device
   * @param {string} pushToken - Expo push token
   * @param {Object} notification - Notification data
   * @param {string} notification.title - Notification title
   * @param {string} notification.body - Notification body
   * @param {Object} notification.data - Additional data
   * @returns {Promise<Object>} Result object with success status
   */
  async sendPushNotification(pushToken, { title, body, data = {} }) {
    try {
      // Validate token
      if (!this.isExpoPushToken(pushToken)) {
        console.warn('[PushNotification] Invalid push token:', pushToken);
        return { success: false, error: 'Invalid push token' };
      }

      // Create message
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

      // Send notification
      const chunks = this.expo.chunkPushNotifications([message]);
      const tickets = [];

      for (const chunk of chunks) {
        try {
          const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        } catch (error) {
          console.error('[PushNotification] Error sending chunk:', error);
          return { success: false, error: error.message };
        }
      }

      // Check ticket errors
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          console.error('[PushNotification] Ticket error:', ticket.message);
          if (ticket.details && ticket.details.error) {
            console.error('[PushNotification] Error details:', ticket.details.error);
          }
          return { success: false, error: ticket.message || 'Unknown error' };
        }
      }

      console.log('[PushNotification] Notification sent successfully');
      return { success: true, tickets };
    } catch (error) {
      console.error('[PushNotification] Error sending push notification:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push notifications to multiple devices
   * @param {Array<string>} pushTokens - Array of Expo push tokens
   * @param {Object} notification - Notification data
   * @returns {Promise<Object>} Result object with success status
   */
  async sendPushNotifications(pushTokens, { title, body, data = {} }) {
    try {
      // Filter valid tokens
      const validTokens = pushTokens.filter(token => this.isExpoPushToken(token));
      
      if (validTokens.length === 0) {
        console.warn('[PushNotification] No valid push tokens provided');
        return { success: false, error: 'No valid push tokens' };
      }

      // Create messages
      const messages = validTokens.map(token => ({
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

      // Send notifications in chunks
      const chunks = this.expo.chunkPushNotifications(messages);
      const tickets = [];

      for (const chunk of chunks) {
        try {
          const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        } catch (error) {
          console.error('[PushNotification] Error sending chunk:', error);
          return { success: false, error: error.message };
        }
      }

      // Check ticket errors
      const errors = [];
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          errors.push(ticket.message || 'Unknown error');
          console.error('[PushNotification] Ticket error:', ticket.message);
        }
      }

      if (errors.length > 0) {
        return { success: false, error: errors.join(', ') };
      }

      console.log(`[PushNotification] Sent ${validTokens.length} notification(s) successfully`);
      return { success: true, tickets, sentCount: validTokens.length };
    } catch (error) {
      console.error('[PushNotification] Error sending push notifications:', error);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();
export default pushNotificationService;
