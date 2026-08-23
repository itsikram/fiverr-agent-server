import express from 'express';
import {
  listUsers,
  listClients,
  getClientById,
  updateClientById,
  listMessages,
  getMessageById,
  updateMessageById,
  setAssignments,
  getAssignments,
  getActivities,
} from '../controllers/adminController.js';
import { debugInfo, debugFilter } from '../controllers/debugController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All admin routes require admin authentication
router.use(requireAdmin);

/**
 * GET /admin/users - Get all users
 */
router.get('/users', listUsers);

/**
 * GET /admin/clients - Get all clients
 */
router.get('/clients', listClients);

/**
 * GET /admin/clients/:clientId - Get single client
 */
router.get('/clients/:clientId', getClientById);

/**
 * PUT /admin/clients/:clientId - Update client
 */
router.put('/clients/:clientId', updateClientById);

/**
 * GET /admin/messages - Get all messages
 */
router.get('/messages', listMessages);

/**
 * GET /admin/messages/:messageId - Get single message
 */
router.get('/messages/:messageId', getMessageById);

/**
 * PUT /admin/messages/:messageId - Update message
 */
router.put('/messages/:messageId', updateMessageById);

/**
 * GET /admin/assignments - Get user assignments
 */
router.get('/assignments', getAssignments);

/**
 * POST /admin/assignments - Set user assignments
 */
router.post('/assignments', setAssignments);

/**
 * GET /admin/activities - Get activity logs
 */
router.get('/activities', getActivities);

/**
 * DEBUG ENDPOINTS (development only)
 */
router.get('/debug/info', debugInfo);
router.get('/debug/filter', debugFilter);

export default router;
