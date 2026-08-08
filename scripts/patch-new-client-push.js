import fs from 'fs';

const path = new URL('../MessageServer.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const startMarker = '  async sendPushNotificationForNewClient(clientInfo) {';
const endMarker = '\n  /**\n   * Broadcast current seller online status to Expo clients.\n   */\n  broadcastSellerOnlineStatus() {';

const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  console.error('markers not found', { start, end });
  process.exit(1);
}

const replacement = `  async sendPushNotificationForNewClient(clientInfo) {
    const { username, name } = clientInfo;

    const targets = await this.getAllPushTargets();
    if (targets.length === 0) {
      return;
    }

    const title = \`New Client: \${name || username}\`;
    const body = \`You have a new client message from \${name || username}!\`;

    const result = await pushNotificationService.sendToTargets(targets, {
      title,
      body,
      data: {
        type: "new_client",
        username: username,
        clientName: name || username,
        conversationId: username,
        isNewClient: true
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
console.log('patched new-client push');
