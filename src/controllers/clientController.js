import { Client } from '../models/Client.js';
import { Assignment } from '../models/Assignment.js';
import { logActivity } from '../utils/activityLogger.js';

/**
 * Normalize a value for case-insensitive comparison
 */
function normalizeForComparison(value) {
  return String(value || '').toLowerCase().trim();
}

/**
 * Find assignments for a user trying multiple identifier fields
 */
async function findUserAssignments(user) {
  if (!user) {
    return null;
  }

  // Try multiple identifier combinations
  const identifiers = [
    user._id?.toString?.(),
    String(user._id || ''),
    user.email,
    user.username,
  ].filter(Boolean);

  console.log('[Client] Searching for assignments with identifiers:', { identifiers });

  // Try each identifier
  for (const id of identifiers) {
    const assignment = await Assignment.findOne({ userId: id });
    if (assignment) {
      console.log('[Client] Found assignment with userId:', { userId: id, clientIds: assignment.clientIds });
      return assignment;
    }
  }

  console.log('[Client] No assignment found for any identifier');
  return null;
}

/**
 * Get clients list for authenticated user
 */
export async function getClients(req, res) {
  try {
    console.log('\n[Client] === getClients called ===');
    
    // Log user info
    console.log('[Client] User info:', {
      _id: req.user?._id,
      email: req.user?.email,
      username: req.user?.username,
      role: req.user?.role,
    });

    // Get all clients
    let clients = await Client.find({ _id: { $ne: null } }).sort({ updated_at: -1 });
    console.log('[Client] Total clients in database:', clients.length);
    
    // Log sample of clients
    console.log('[Client] First 5 clients:');
    clients.slice(0, 5).forEach(c => {
      console.log(`  - ${c.username || c._id} (username=${c.username}, _id=${c._id}, conversationId=${c.conversationId})`);
    });

    // Filter by user assignments if not admin
    if (req.user && req.user.role !== 'admin') {
      console.log('[Client] User is not admin, applying assignment filter...');
      
      const assignments = await findUserAssignments(req.user);
      const assignedIds = assignments?.clientIds || [];

      console.log('[Client] Assigned IDs for user:', assignedIds);
      console.log('[Client] Number of assigned clients:', assignedIds.length);

      if (assignedIds.length > 0) {
        // Normalize assigned IDs for case-insensitive comparison
        const normalizedAssignedIds = new Set(
          assignedIds.map(id => normalizeForComparison(id)).filter(Boolean)
        );

        console.log('[Client] Normalized assigned IDs:', Array.from(normalizedAssignedIds));

        const beforeCount = clients.length;
        const matchedClients = [];
        const unmatchedClients = [];

        clients = clients.filter((client) => {
          // Check multiple potential matching fields (like MessageServer does)
          const candidateFields = [
            { name: '_id', value: client._id },
            { name: 'id', value: client.id },
            { name: 'clientId', value: client.clientId },
            { name: 'client_id', value: client.client_id },
            { name: 'clientKey', value: client.clientKey },
            { name: 'username', value: client.username },
            { name: 'clientUsername', value: client.clientUsername },
            { name: 'client', value: client.client },
            { name: 'conversationId', value: client.conversationId },
            { name: 'conversation_id', value: client.conversation_id },
          ];

          const match = candidateFields.some(field => {
            if (!field.value) return false;
            const normalized = normalizeForComparison(field.value);
            return normalized && normalizedAssignedIds.has(normalized);
          });

          if (match) {
            matchedClients.push({
              username: client.username,
              _id: client._id,
              clientKey: client.clientKey,
              conversationId: client.conversationId,
            });
          } else {
            // Only log first 5 unmatched for brevity
            if (unmatchedClients.length < 5) {
              unmatchedClients.push({
                username: client.username,
                _id: client._id,
                clientKey: client.clientKey,
                conversationId: client.conversationId,
              });
            }
          }

          return match;
        });
        
        console.log('[Client] Filtering results:', {
          before: beforeCount,
          after: clients.length,
          matched: matchedClients,
          unmatchedSample: unmatchedClients,
        });
      } else {
        console.log('[Client] No assignments found for user, returning empty list');
        clients = [];
      }
    } else {
      console.log('[Client] User is admin, returning all clients');
    }

    console.log('[Client] Final result: returning', clients.length, 'clients\n');

    // Log activity
    await logActivity(req, 'clients_viewed', { count: clients.length });

    res.json({ clients });
  } catch (error) {
    console.error('[Client] Get clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get user assignments
 */
export async function getMyAssignments(req, res) {
  try {
    console.log('\n[Client] === getMyAssignments called ===');
    console.log('[Client] User:', {
      _id: req.user?._id,
      email: req.user?.email,
      username: req.user?.username,
    });

    const assignments = await findUserAssignments(req.user);

    console.log('[Client] Found assignments:', {
      found: !!assignments,
      clientIds: assignments?.clientIds || [],
    });

    res.json({
      clientIds: assignments?.clientIds || [],
    });
  } catch (error) {
    console.error('[Client] Get assignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
