import crypto from 'crypto';
import { User } from '../models/User.js';
import { Activity } from '../models/Activity.js';
import { emailService } from '../services/EmailService.js';
import { logActivity } from '../utils/activityLogger.js';

/**
 * Hash password with salt
 */
async function hashPassword(password, salt = null) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(password, actualSalt, 100000, 32, 'sha256').toString('hex');
  return { salt: actualSalt, hash: derivedKey };
}

/**
 * Verify password
 */
async function verifyPassword(password, salt, hash) {
  const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return derivedKey === hash;
}

/**
 * Generate auth token
 */
function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate password reset token
 */
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Register new user
 */
export async function register(req, res) {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Missing email, username, or password' });
    }

    // Check if user exists
    let user = await User.findOne({ $or: [{ email }, { username }] });
    if (user) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const { salt, hash } = await hashPassword(password);

    // Create user
    user = new User({
      username,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      role: 'user',
      authTokens: [],
    });

    await user.save();

    // Generate token
    const token = generateAuthToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          authTokens: { token, expires },
        },
      }
    );

    // Log activity for user registration
    const activity = new Activity({
      type: 'registration',
      username: user.username,
      role: user.role,
      data: { email: user.email },
    });
    await activity.save();

    res.status(201).json({
      success: true,
      token,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    console.error('[Auth] Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Login user
 */
export async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token
    const token = generateAuthToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          authTokens: { token, expires },
        },
      }
    );

    // Log activity for login
    if (user.role !== 'admin') {
      const activity = new Activity({
        type: 'login',
        username: user.username,
        role: user.role,
        data: { email: user.email },
      });
      await activity.save();
    }

    res.json({
      success: true,
      token,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get current user info
 */
export async function getMe(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    res.json({
      success: true,
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
    });
  } catch (error) {
    console.error('[Auth] Get me error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Logout user
 */
export async function logout(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Invalidate token
    await User.updateOne(
      { _id: req.user._id },
      {
        $pull: {
          authTokens: { token: req.query.token || '' },
        },
      }
    );

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('[Auth] Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Request password reset
 */
export async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if email exists (security best practice)
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent.',
      });
    }

    // Generate reset token
    const resetToken = generateResetToken();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    console.log('[Auth] PASSWORD RESET TOKEN (sensitive):', {
      email,
      token: resetToken,
      expiresAt: resetExpires.toISOString(),
    });

    // Save reset token to user
    await User.updateOne(
      { _id: user._id },
      {
        passwordReset: {
          token: resetToken,
          expires: resetExpires,
        },
      }
    );

    // Build reset link (adjust based on your frontend URL)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

    // Send email (but don't fail if email service is not configured)
    try {
      await emailService.sendPasswordResetEmail(email, resetToken, resetLink);
    } catch (emailError) {
      console.error('[Auth] Email sending failed, but continuing:', emailError.message);
      // Don't throw - let the user continue even if email fails
    }

    res.json({
      success: true,
      message: 'Password reset link has been sent to your email.',
    });
  } catch (error) {
    console.error('[Auth] Request password reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Reset password with token
 */
export async function resetPassword(req, res) {
  try {
    const { email, token, newPassword } = req.body;

    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'Email, token, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or reset token' });
    }

    // Verify reset token
    if (
      !user.passwordReset ||
      user.passwordReset.token !== token ||
      new Date() > user.passwordReset.expires
    ) {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    // Hash new password
    const { salt, hash } = await hashPassword(newPassword);

    // Update password and clear reset token
    await User.updateOne(
      { _id: user._id },
      {
        passwordHash: hash,
        passwordSalt: salt,
        passwordReset: null,
      }
    );

    res.json({
      success: true,
      message: 'Password has been reset successfully.',
    });
  } catch (error) {
    console.error('[Auth] Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
