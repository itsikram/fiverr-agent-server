import { Client } from '../models/Client.js';
import { Assignment } from '../models/Assignment.js';
import { User } from '../models/User.js';

/**
 * Debug endpoint - shows raw database data
 * ONLY USE FOR DEVELOPMENT
 */
export async function debugInfo(req, res) {
  try {
    // Check auth
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const info = {
      timestamp: new Date().toISOString(),
      clients: {
        total: 0,
        sample: [],
      },
      assignments: {
        total: 0,
        all: [],
      },
      searchingFor: ['jerynadim', 'calina590', 'oliverog397', 'briana_lyn'],
    };

    // Get all clients
    const allClients = await Client.find({}).limit(100);
    info.clients.total = allClients.length;
    
    // Show first 10 clients
    info.clients.sample = allClients.slice(0, 10).map(c => ({
      _id: c._id,
      username: c.username,
      clientKey: c.clientKey,
      conversationId: c.conversationId,
      clientUsername: c.clientUsername,
      client: c.client,
      id: c.id,
    }));

    // Check if our assigned clients exist
    const assignedClientSearch = await Client.find({
      $or: [
        { _id: { $in: ['jerynadim', 'calina590', 'oliverog397', 'briana_lyn'] } },
        { username: { $in: ['jerynadim', 'calina590', 'oliverog397', 'briana_lyn'] } },
        { clientKey: { $in: ['jerynadim', 'calina590', 'oliverog397', 'briana_lyn'] } },
      ],
    });

    info.assignedClientsFound = assignedClientSearch.map(c => ({
      _id: c._id,
      username: c.username,
      clientKey: c.clientKey,
    }));

    // Get all assignments
    const allAssignments = await Assignment.find({});
    info.assignments.total = allAssignments.length;
    info.assignments.all = allAssignments.map(a => ({
      _id: a._id,
      userId: a.userId,
      clientIds: a.clientIds,
    }));

    // Get current user info
    if (req.user) {
      info.currentUser = {
        _id: req.user._id?.toString(),
        email: req.user.email,
        username: req.user.username,
        role: req.user.role,
      };

      // Try to find assignment for current user
      const userAssignment = await Assignment.findOne({
        $or: [
          { userId: req.user._id?.toString() },
          { userId: req.user.email },
          { userId: req.user.username },
        ],
      });

      info.currentUserAssignment = userAssignment ? {
        userId: userAssignment.userId,
        clientIds: userAssignment.clientIds,
      } : null;
    }

    res.json(info);
  } catch (error) {
    console.error('[Debug] Error:', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Debug endpoint - test filtering logic
 */
export async function debugFilter(req, res) {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const testAssignedIds = ['jerynadim', 'calina590', 'oliverog397'];
    
    const result = {
      testAssignedIds,
      totalClients: 0,
      matchedClients: [],
      unmatchedSample: [],
    };

    // Get all clients
    const clients = await Client.find({});
    result.totalClients = clients.length;

    // Create normalized set like the filter does
    function normalizeForComparison(value) {
      return String(value || '').toLowerCase().trim();
    }

    const normalizedAssignedIds = new Set(
      testAssignedIds.map(id => normalizeForComparison(id)).filter(Boolean)
    );

    console.log('[Debug] Normalized assigned IDs:', Array.from(normalizedAssignedIds));

    // Try filtering
    const unmatched = [];
    for (const client of clients) {
      const candidateFields = [
        client._id,
        client.id,
        client.clientId,
        client.client_id,
        client.clientKey,
        client.username,
        client.clientUsername,
        client.client,
        client.conversationId,
        client.conversation_id,
      ];

      const match = candidateFields.some(field => {
        const normalized = normalizeForComparison(field);
        return normalized && normalizedAssignedIds.has(normalized);
      });

      if (match) {
        result.matchedClients.push({
          _id: client._id,
          username: client.username,
          clientKey: client.clientKey,
          matched: true,
        });
      } else if (unmatched.length < 5) {
        unmatched.push({
          _id: client._id,
          username: client.username,
          clientKey: client.clientKey,
          fields: {
            _id: client._id,
            username: client.username,
            clientKey: client.clientKey,
            conversationId: client.conversationId,
          },
        });
      }
    }

    result.unmatchedSample = unmatched;

    res.json(result);
  } catch (error) {
    console.error('[Debug] Filter error:', error);
    res.status(500).json({ error: error.message });
  }
}
