import { User } from '../models/User.js';
import { Client } from '../models/Client.js';
import { Message } from '../models/Message.js';
import { Assignment } from '../models/Assignment.js';
import { Activity } from '../models/Activity.js';

/**
 * Get all users (admin only)
 */
export async function listUsers(req, res) {
  try {
    const users = await User.find({}).select('-passwordHash -passwordSalt -authTokens').sort({ created_at: -1 });
    console.log('[Admin] List users', { count: users.length });
    res.json({ users });
  } catch (error) {
    console.error('[Admin] List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}


export async function listClients(req, res) {
  try {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    const clients = await Client.find({ _id: { $ne: null } }).sort({ created_at: -1 }).lean();
    
    // Ensure timestamps are included in response
    const clientsWithTimestamps = clients.map(c => ({
      ...c,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
    
    res.json({ clients: clientsWithTimestamps });
  } catch (error) {
    console.error('[Admin] List clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get single client by ID (admin only)
 */
export async function getClientById(req, res) {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ error: 'Missing client ID' });
    }

    const client = await Client.findOne({ _id: clientId });
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ client });
  } catch (error) {
    console.error('[Admin] Get client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Update client by ID (admin only)
 */
export async function updateClientById(req, res) {
  try {
    const { clientId } = req.params;
    const { body } = req;

    if (!clientId) {
      return res.status(400).json({ error: 'Missing client ID' });
    }

    const updateDoc = { ...body, updated_at: new Date() };

    await Client.updateOne({ _id: clientId }, { $set: updateDoc }, { upsert: true });

    const updated = await Client.findOne({ _id: clientId });

    res.json({ success: true, client: updated });
  } catch (error) {
    console.error('[Admin] Update client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get all messages (admin only)
 */
export async function listMessages(req, res) {
  try {
    const messages = await Message.find({}).sort({ updated_at: -1 });
    res.json({ messages });
  } catch (error) {
    console.error('[Admin] List messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get single message by ID (admin only)
 */
export async function getMessageById(req, res) {
  try {
    const { messageId } = req.params;

    if (!messageId) {
      return res.status(400).json({ error: 'Missing message ID' });
    }

    const message = await Message.findOne({ _id: messageId });
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message });
  } catch (error) {
    console.error('[Admin] Get message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Update message by ID (admin only)
 */
export async function updateMessageById(req, res) {
  try {
    const { messageId } = req.params;
    const { body } = req;

    if (!messageId) {
      return res.status(400).json({ error: 'Missing message ID' });
    }

    const updateDoc = { ...body, updated_at: new Date() };

    await Message.updateOne({ _id: messageId }, { $set: updateDoc }, { upsert: true });

    const updated = await Message.findOne({ _id: messageId });

    res.json({ success: true, message: updated });
  } catch (error) {
    console.error('[Admin] Update message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Set user client assignments (admin only)
 */
export async function setAssignments(req, res) {
  try {
    const { userId, clientIds } = req.body;

    console.log('[Admin] setAssignments called with:', { userId, clientIds });

    if (!userId) {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const normalizedIds = (clientIds || []).map((id) => ({ _id: id }));

    const result = await Assignment.updateOne(
      { userId },
      {
        $set: {
          userId,
          clientIds: clientIds || [],
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );

    console.log('[Admin] Assignment saved:', { 
      userId, 
      clientIds,
      updateResult: result 
    });

    const assignments = await Assignment.find({ userId });

    console.log('[Admin] Verification - assignments in DB:', assignments);

    res.json({ success: true, assignments });
  } catch (error) {
    console.error('[Admin] Set assignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get assignments for user (admin only)
 */
export async function getAssignments(req, res) {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const assignments = await Assignment.findOne({ userId });

    res.json({
      clientIds: assignments?.clientIds || [],
    });
  } catch (error) {
    console.error('[Admin] Get assignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get activity logs (admin only)
 */
export async function getActivities(req, res) {
  try {
    const { userId, activityType, limit = 50 } = req.query;

    const filter = { role: { $ne: 'admin' } };

    if (userId) filter.username = userId;
    if (activityType) filter.type = activityType;

    const activities = await Activity.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.min(parseInt(limit) || 50, 500));

    // Map 'type' to 'activityType' for frontend compatibility
    const formattedActivities = activities.map(activity => ({
      ...activity.toObject(),
      activityType: activity.type,
    }));

    res.json({ activities: formattedActivities });
  } catch (error) {
    console.error('[Admin] Get activities error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
