/**
 * Data access layer over Prisma (MySQL).
 *
 * Rows are returned as plain "documents" shaped like the old MongoDB records
 * (`_id`, `created_at`, `updated_at`, plus any extra fields) so API responses
 * and the WebSocket payloads stay unchanged.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function toStringOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

// Strip values that cannot be stored as JSON (Dates become ISO strings).
function toJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/**
 * Split a document into column values and the `extra` JSON blob.
 */
function packDoc(doc, columns) {
  const { _id, created_at, updated_at, ...rest } = doc || {};
  const data = {};
  for (const column of columns) {
    if (column in rest) {
      data[column] = toStringOrNull(rest[column]);
      delete rest[column];
    }
  }
  data.extra = toJson(rest);
  return { data, createdAt: toDate(created_at), updatedAt: toDate(updated_at) };
}

function unpackDoc(row, columns) {
  if (!row) {
    return null;
  }
  const doc = { ...(row.extra && typeof row.extra === 'object' ? row.extra : {}) };
  for (const column of columns) {
    if (row[column] !== null && row[column] !== undefined) {
      doc[column] = row[column];
    }
  }
  doc._id = row.id;
  doc.created_at = toIso(row.createdAt);
  doc.updated_at = toIso(row.updatedAt);
  return doc;
}

/**
 * Generic store for document-style tables (id + indexed columns + extra JSON).
 */
function createDocumentStore(delegate, columns) {
  const unpack = (row) => unpackDoc(row, columns);

  async function findById(id) {
    if (id === null || id === undefined || id === '') {
      return null;
    }
    return unpack(await delegate.findUnique({ where: { id: String(id) } }));
  }

  async function list({ where = {}, orderBy = 'updated_at', direction = 'desc', limit } = {}) {
    const rows = await delegate.findMany({
      where,
      orderBy: { [orderBy === 'created_at' ? 'createdAt' : 'updatedAt']: direction },
      ...(limit ? { take: limit } : {}),
    });
    return rows.map(unpack);
  }

  /**
   * Merge `fields` into the document (like Mongo `$set`).
   * With `upsert`, a missing document is created; otherwise returns null.
   */
  async function set(id, fields, { upsert = false } = {}) {
    const key = String(id);
    const existing = await findById(key);
    if (!existing && !upsert) {
      return null;
    }

    const merged = { ...(existing || {}), ...fields };
    const { data, createdAt } = packDoc(merged, columns);
    const timestamps = { updatedAt: toDate(fields?.updated_at, new Date()) };

    if (existing) {
      return unpack(await delegate.update({ where: { id: key }, data: { ...data, ...timestamps } }));
    }

    return unpack(
      await delegate.upsert({
        where: { id: key },
        create: { id: key, ...data, ...timestamps, createdAt: createdAt || new Date() },
        update: { ...data, ...timestamps },
      })
    );
  }

  /**
   * Replace the whole document (like Mongo `replaceOne` with upsert).
   */
  async function replace(id, doc) {
    const key = String(id);
    const { data, createdAt, updatedAt } = packDoc(doc, columns);
    for (const column of columns) {
      if (!(column in data)) {
        data[column] = null;
      }
    }
    const timestamps = { updatedAt: updatedAt || new Date() };
    return unpack(
      await delegate.upsert({
        where: { id: key },
        create: { id: key, ...data, ...timestamps, createdAt: createdAt || new Date() },
        update: { ...data, ...timestamps },
      })
    );
  }

  async function remove(id) {
    const result = await delegate.deleteMany({ where: { id: String(id) } });
    return result.count > 0;
  }

  return { findById, list, set, replace, remove, unpack };
}

function userToDoc(row, { includeSecrets = true } = {}) {
  if (!row) {
    return null;
  }
  const doc = {
    _id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
  if (includeSecrets) {
    doc.passwordHash = row.passwordHash;
    doc.passwordSalt = row.passwordSalt;
    doc.passwordReset = row.passwordResetToken
      ? { token: row.passwordResetToken, expires: row.passwordResetExpires }
      : null;
    doc.authTokens = (row.authTokens || []).map((item) => ({
      token: item.token,
      expires: item.expires,
    }));
  }
  return doc;
}

function userWhere({ id, email }) {
  if (id !== undefined && id !== null && id !== '') {
    return { id: String(id) };
  }
  if (email) {
    return { email: String(email).toLowerCase().trim() };
  }
  return null;
}

function createUserStore(prisma) {
  const include = { authTokens: true };

  return {
    async findById(id) {
      if (id === null || id === undefined || id === '') {
        return null;
      }
      return userToDoc(await prisma.user.findUnique({ where: { id: String(id) }, include }));
    },

    async findByEmail(email) {
      if (!email) {
        return null;
      }
      const normalized = String(email).toLowerCase().trim();
      return userToDoc(await prisma.user.findUnique({ where: { email: normalized }, include }));
    },

    async findByEmailOrUsername(email, username) {
      const or = [];
      if (email) or.push({ email: String(email).toLowerCase().trim() });
      if (username) or.push({ username: String(username).trim() });
      if (!or.length) {
        return null;
      }
      return userToDoc(await prisma.user.findFirst({ where: { OR: or }, include }));
    },

    async findByToken(token) {
      if (!token) {
        return null;
      }
      const row = await prisma.authToken.findFirst({
        where: { token: String(token), expires: { gt: new Date() } },
        include: { user: { include } },
      });
      return userToDoc(row?.user);
    },

    async list() {
      const rows = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map((row) => userToDoc(row, { includeSecrets: false }));
    },

    async create({ username, email, passwordHash, passwordSalt, role = 'user' }) {
      const row = await prisma.user.create({
        data: {
          username: String(username).trim(),
          email: String(email).toLowerCase().trim(),
          passwordHash,
          passwordSalt,
          role,
        },
        include,
      });
      return userToDoc(row);
    },

    /**
     * Update a user selected by { id } or { email }.
     * `fields.passwordReset` accepts { token, expires } or null.
     */
    async update(selector, fields) {
      const where = userWhere(selector);
      if (!where) {
        return false;
      }
      const data = {};
      for (const key of ['username', 'passwordHash', 'passwordSalt', 'role']) {
        if (fields[key] !== undefined) data[key] = fields[key];
      }
      if (fields.email !== undefined) {
        data.email = String(fields.email).toLowerCase().trim();
      }
      if (fields.passwordReset !== undefined) {
        data.passwordResetToken = fields.passwordReset?.token || null;
        data.passwordResetExpires = toDate(fields.passwordReset?.expires);
      }
      const result = await prisma.user.updateMany({ where, data });
      return result.count > 0;
    },

    async addAuthToken(selector, token, expires = new Date(Date.now() + TOKEN_TTL_MS)) {
      const where = userWhere(selector);
      if (!where || !token) {
        return false;
      }
      const user = await prisma.user.findUnique({ where, select: { id: true } });
      if (!user) {
        return false;
      }
      await prisma.authToken.create({ data: { token, expires, userId: user.id } });
      await prisma.user.update({ where: { id: user.id }, data: { updatedAt: new Date() } });
      return true;
    },

    async removeAuthToken(token, userId = null) {
      if (!token) {
        return false;
      }
      const where = { token: String(token) };
      if (userId) {
        where.userId = String(userId);
      }
      const result = await prisma.authToken.deleteMany({ where });
      return result.count > 0;
    },
  };
}

function assignmentToDoc(row) {
  return {
    _id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

function createAssignmentStore(prisma) {
  return {
    async listAll() {
      const rows = await prisma.assignment.findMany({ orderBy: { updatedAt: 'desc' } });
      return rows.map(assignmentToDoc);
    },

    async listForUser(userId) {
      if (!userId) {
        return [];
      }
      const rows = await prisma.assignment.findMany({
        where: { userId: String(userId) },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(assignmentToDoc);
    },

    /**
     * Replace every assignment for a user with `clientIds`.
     */
    async replaceForUser(userId, clientIds) {
      const normalizedUserId = String(userId).trim();
      const ids = Array.from(
        new Set((clientIds || []).map((value) => toStringOrNull(value)).filter(Boolean))
      );
      const now = new Date();
      await prisma.$transaction([
        prisma.assignment.deleteMany({ where: { userId: normalizedUserId } }),
        prisma.assignment.createMany({
          data: ids.map((clientId) => ({
            id: `${normalizedUserId}:${clientId}`,
            userId: normalizedUserId,
            clientId,
            createdAt: now,
            updatedAt: now,
          })),
        }),
      ]);
      return true;
    },
  };
}

const ACTIVITY_COLUMNS = ['role', 'type', 'activityType', 'username', 'userId'];

function createActivityStore(prisma) {
  const unpack = (row) => unpackDoc(row, ACTIVITY_COLUMNS);

  return {
    async create(doc) {
      const { data, createdAt, updatedAt } = packDoc(doc, ACTIVITY_COLUMNS);
      const now = new Date();
      return unpack(
        await prisma.activity.create({
          data: { ...data, createdAt: createdAt || now, updatedAt: updatedAt || now },
        })
      );
    },

    /**
     * filter: { username, userId, type, activityType, excludeRole }
     */
    async list({ username, userId, type, activityType, excludeRole, limit = 100 } = {}) {
      const where = {};
      if (username) where.username = String(username);
      if (userId) where.userId = String(userId);
      if (type) where.type = String(type);
      if (activityType) where.activityType = String(activityType);
      if (excludeRole) {
        // Mongo `$ne` also matched documents without a role.
        where.OR = [{ role: { not: excludeRole } }, { role: null }];
      }
      const rows = await prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map(unpack);
    },
  };
}

function pushSubscriptionToDoc(row) {
  return {
    _id: row.id,
    type: row.type,
    endpoint: row.endpoint,
    subscription: row.subscription,
    userId: row.userId,
    sessionId: row.sessionId,
    registeredAt: row.registeredAt ? row.registeredAt.getTime() : null,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

function createPushSubscriptionStore(prisma) {
  return {
    async list({ type, limit = 2000 } = {}) {
      const rows = await prisma.pushSubscription.findMany({
        where: type ? { type } : {},
        take: limit,
      });
      return rows.map(pushSubscriptionToDoc);
    },

    async upsert(record) {
      const data = {
        type: record.type || 'web',
        subscription: toJson(record.subscription),
        userId: toStringOrNull(record.userId),
        sessionId: toStringOrNull(record.sessionId),
        registeredAt: toDate(record.registeredAt, new Date()),
      };
      await prisma.pushSubscription.upsert({
        where: { endpoint: record.endpoint },
        create: { endpoint: record.endpoint, ...data },
        update: data,
      });
    },

    async removeByEndpoint(endpoint) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    },
  };
}

const CLIENT_COLUMNS = ['username', 'conversationId', 'clientKey'];
const MESSAGE_COLUMNS = ['clientId', 'clientUsername', 'conversationId'];
const SELLER_PROFILE_COLUMNS = ['username'];

/**
 * Build the store for a PrismaClient.
 */
export function createStore(prisma) {
  const clientDocs = createDocumentStore(prisma.client, CLIENT_COLUMNS);
  const messageDocs = createDocumentStore(prisma.message, MESSAGE_COLUMNS);

  return {
    users: createUserStore(prisma),
    assignments: createAssignmentStore(prisma),
    activities: createActivityStore(prisma),
    pushSubscriptions: createPushSubscriptionStore(prisma),
    sellerProfiles: createDocumentStore(prisma.sellerProfile, SELLER_PROFILE_COLUMNS),

    clients: {
      ...clientDocs,

      // Every client except the legacy aggregate "client_list" record.
      list(options = {}) {
        return clientDocs.list({ ...options, where: { id: { not: 'client_list' } } });
      },

      // Match a key against _id, username or conversationId.
      async findByKey(key) {
        const value = toStringOrNull(key);
        if (!value) {
          return null;
        }
        const row = await prisma.client.findFirst({
          where: { OR: [{ id: value }, { username: value }, { conversationId: value }] },
        });
        return clientDocs.unpack(row);
      },

      // Clients whose _id, username or clientKey is in `keys`.
      async findByAnyKey(keys) {
        const values = (keys || []).map(toStringOrNull).filter(Boolean);
        if (!values.length) {
          return [];
        }
        const rows = await prisma.client.findMany({
          where: {
            OR: [{ id: { in: values } }, { username: { in: values } }, { clientKey: { in: values } }],
          },
        });
        return rows.map(clientDocs.unpack);
      },
    },

    messages: {
      ...messageDocs,

      async removeByClientId(clientId) {
        const result = await prisma.message.deleteMany({ where: { clientId: String(clientId) } });
        return result.count;
      },
    },
  };
}
