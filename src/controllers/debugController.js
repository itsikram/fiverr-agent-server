import { getStore } from '../config/database.js';

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
    const store = getStore();
    const allClients = await store.clients.list({ limit: 100 });
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
    const assignedClientSearch = await store.clients.findByAnyKey(
      ['jerynadim', 'calina590', 'oliverog397', 'briana_lyn']
    );

    info.assignedClientsFound = assignedClientSearch.map(c => ({
      _id: c._id,
      username: c.username,
      clientKey: c.clientKey,
    }));

    // Get all assignments
    const allAssignments = await store.assignments.listAll();
    info.assignments.total = allAssignments.length;
    info.assignments.all = allAssignments.map(a => ({
      _id: a._id,
      userId: a.userId,
      clientId: a.clientId,
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
      let userAssignment = null;
      for (const id of [req.user._id?.toString(), req.user.email, req.user.username]) {
        const rows = id ? await store.assignments.listForUser(id) : [];
        if (rows.length > 0) {
          userAssignment = { userId: id, clientIds: rows.map((row) => row.clientId) };
          break;
        }
      }

      info.currentUserAssignment = userAssignment;
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
    const clients = await getStore().clients.list();
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
