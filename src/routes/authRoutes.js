import express from 'express';
import { register, login, getMe, logout, requestPasswordReset, resetPassword } from '../controllers/authController.js';
import { authenticate, extractToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /auth/register - Register new user
 */
router.post('/register', register);

/**
 * POST /auth/login - Login user
 */
router.post('/login', login);

/**
 * GET /auth/me - Get current user info
 */
router.get('/me', authenticate, getMe);

/**
 * POST /auth/logout - Logout user
 */
router.post('/logout', authenticate, logout);

/**
 * POST /auth/request-password-reset - Request password reset email
 */
router.post('/request-password-reset', requestPasswordReset);

/**
 * POST /auth/reset-password - Reset password with token
 */
router.post('/reset-password', resetPassword);

export default router;
