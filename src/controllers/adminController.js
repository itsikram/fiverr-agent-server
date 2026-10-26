import { getStore } from '../config/database.js';

/**
 * Get all users (admin only)
 */
export async function listUsers(req, res) {
  try {
    const users = await getStore().users.list();
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
    
    const clients = await getStore().clients.list({ orderBy: 'created_at' });
    
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

    const client = await getStore().clients.findById(clientId);
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

    const updated = await getStore().clients.set(clientId, updateDoc, { upsert: true });

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
    const messages = await getStore().messages.list();
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

    const message = await getStore().messages.findById(messageId);
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

    const updated = await getStore().messages.set(messageId, updateDoc, { upsert: true });

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

    const store = getStore();
    await store.assignments.replaceForUser(userId, clientIds || []);

    console.log('[Admin] Assignment saved:', { userId, clientIds });

    const rows = await store.assignments.listForUser(userId);
    const assignments = [{ userId, clientIds: rows.map((row) => row.clientId) }];

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

    const rows = await getStore().assignments.listForUser(userId);

    res.json({
      clientIds: rows.map((row) => row.clientId),
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

    const activities = await getStore().activities.list({
      excludeRole: 'admin',
      username: userId || undefined,
      type: activityType || undefined,
      limit: Math.min(parseInt(limit) || 50, 500),
    });

    // Map 'type' to 'activityType' for frontend compatibility
    const formattedActivities = activities.map(activity => ({
      ...activity,
      activityType: activity.type,
    }));

    res.json({ activities: formattedActivities });
  } catch (error) {
    console.error('[Admin] Get activities error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
