import express from 'express';
import pushNotificationService from '../../utils/pushNotificationService.js';

const router = express.Router();

/**
 * GET /push/vapid-public-key - Get VAPID public key
 */
router.get('/vapid-public-key', (req, res) => {
  try {
    const publicKey = pushNotificationService.getVapidPublicKey();

    if (!publicKey) {
      return res.status(503).json({
        error: 'VAPID keys are not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.',
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({ publicKey });
  } catch (error) {
    console.error('[Push] VAPID key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
