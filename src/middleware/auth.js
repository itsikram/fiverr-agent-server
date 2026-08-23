import { User } from '../models/User.js';

/**
 * Extract token from Authorization header
 */
export function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Verify user by token
 */
export async function verifyToken(token) {
  if (!token) {
    return null;
  }

  try {
    const user = await User.findOne({
      authTokens: {
        $elemMatch: {
          token,
          expires: { $gt: new Date() },
        },
      },
    });

    return user;
  } catch (error) {
    console.error('[Auth] Token verification failed:', error.message);
    return null;
  }
}

/**
 * Authentication middleware
 */
export async function authenticate(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
}

/**
 * Admin authentication middleware
 */
export async function requireAdmin(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const user = await verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.user = user;
  next();
}

/**
 * Optional authentication - doesn't fail if token is missing
 */
export async function optionalAuth(req, res, next) {
  const token = extractToken(req);

  if (token) {
    const user = await verifyToken(token);
    if (user) {
      req.user = user;
    }
  }

  next();
}
