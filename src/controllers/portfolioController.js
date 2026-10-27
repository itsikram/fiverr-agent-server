import { randomUUID } from 'crypto';
import { getStore } from '../config/database.js';

const MAX_ITEMS_PER_USER = 500;
const MAX_SKILLS = 20;

function cleanText(value, maxLength) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().slice(0, maxLength);
}

/**
 * Accept "example.com" or a full http(s) URL; anything else becomes ''.
 */
export function normalizeWebsiteUrl(value) {
  const text = cleanText(value, 2048);
  if (!text) {
    return '';
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function cleanSkills(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const skills = [];
  for (const entry of list) {
    const skill = cleanText(entry, 40);
    const key = skill.toLowerCase();
    if (skill && !seen.has(key)) {
      seen.add(key);
      skills.push(skill);
    }
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills;
}

function cleanDate(value) {
  const text = cleanText(value, 40);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function cleanRating(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const rating = Number(value);
  if (!Number.isFinite(rating)) {
    return null;
  }
  return Math.min(5, Math.max(0, Math.round(rating * 10) / 10));
}

/**
 * Build the stored fields from a request body. With `partial`, only the
 * fields present in the body are returned (for updates).
 */
export function sanitizePortfolioInput(body = {}, { partial = false } = {}) {
  const fields = {
    title: () => cleanText(body.title, 160),
    websiteUrl: () => normalizeWebsiteUrl(body.websiteUrl),
    task: () => cleanText(body.task, 5000),
    result: () => cleanText(body.result, 2000),
    category: () => cleanText(body.category, 80),
    skills: () => cleanSkills(body.skills),
    clientId: () => cleanText(body.clientId, 255) || null,
    clientUsername: () => cleanText(body.clientUsername, 255) || null,
    clientName: () => cleanText(body.clientName, 160),
    clientCountry: () => cleanText(body.clientCountry, 80),
    completedAt: () => cleanDate(body.completedAt),
    rating: () => cleanRating(body.rating),
    testimonial: () => cleanText(body.testimonial, 2000),
    imageUrl: () => normalizeWebsiteUrl(body.imageUrl),
    featured: () => Boolean(body.featured),
    isPublic: () => Boolean(body.isPublic),
    showClientName: () => Boolean(body.showClientName),
    // Set when the app adds a completed order automatically.
    autoAdded: () => Boolean(body.autoAdded),
    sourceKey: () => cleanText(body.sourceKey, 255) || null,
  };

  const result = {};
  for (const [key, read] of Object.entries(fields)) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, key)) {
      result[key] = read();
    }
  }
  return result;
}

function validate(fields, { partial = false } = {}) {
  if (!partial || 'title' in fields) {
    if (!fields.title) {
      return 'A project title is required';
    }
  }
  if (!partial && !fields.websiteUrl && !fields.task) {
    return 'Add a website or a task description';
  }
  return null;
}

// Featured first, then most recently completed (or created).
export function sortPortfolioItems(items) {
  const when = (item) => item.completedAt || item.created_at || '';
  return [...items].sort((a, b) => {
    if (Boolean(b.featured) !== Boolean(a.featured)) {
      return b.featured ? 1 : -1;
    }
    return String(when(b)).localeCompare(String(when(a)));
  });
}

// What anyone with the share link may see.
export function toPublicItem(item) {
  return {
    _id: item._id,
    title: item.title,
    websiteUrl: item.websiteUrl || '',
    task: item.task || '',
    result: item.result || '',
    category: item.category || '',
    skills: item.skills || [],
    completedAt: item.completedAt || null,
    rating: item.rating ?? null,
    testimonial: item.testimonial || '',
    imageUrl: item.imageUrl || '',
    featured: Boolean(item.featured),
    clientCountry: item.clientCountry || '',
    clientName: item.showClientName ? item.clientName || '' : '',
  };
}

function ownerId(user) {
  return String(user?._id || '');
}

async function findOwnedItem(req) {
  const item = await getStore().portfolio.findById(req.params.id);
  if (!item || String(item.userId) !== ownerId(req.user)) {
    return null;
  }
  return item;
}

/**
 * GET /portfolio - the signed-in user's portfolio
 */
export async function listPortfolio(req, res) {
  try {
    const items = await getStore().portfolio.list({
      where: { userId: ownerId(req.user) },
      limit: MAX_ITEMS_PER_USER,
    });
    res.json({ items: sortPortfolioItems(items) });
  } catch (error) {
    console.error('[Portfolio] List error:', error);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
}

/**
 * POST /portfolio - add a project
 */
export async function createPortfolioItem(req, res) {
  try {
    const fields = sanitizePortfolioInput(req.body);
    const error = validate(fields);
    if (error) {
      return res.status(400).json({ error });
    }

    const { portfolio } = getStore();
    const existing = await portfolio.list({
      where: { userId: ownerId(req.user) },
      limit: MAX_ITEMS_PER_USER,
    });

    // Auto-added orders are idempotent: the same order never adds twice,
    // even when several devices notice it.
    if (fields.sourceKey) {
      const duplicate = existing.find((item) => item.sourceKey === fields.sourceKey);
      if (duplicate) {
        return res.status(200).json({ item: duplicate, duplicate: true });
      }
    }

    if (existing.length >= MAX_ITEMS_PER_USER) {
      return res.status(400).json({ error: `Portfolio is limited to ${MAX_ITEMS_PER_USER} projects` });
    }

    const item = await portfolio.set(
      randomUUID(),
      { ...fields, userId: ownerId(req.user) },
      { upsert: true }
    );
    res.status(201).json({ item });
  } catch (error) {
    console.error('[Portfolio] Create error:', error);
    res.status(500).json({ error: 'Failed to save project' });
  }
}

/**
 * PUT /portfolio/:id - update a project
 */
export async function updatePortfolioItem(req, res) {
  try {
    const existing = await findOwnedItem(req);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const fields = sanitizePortfolioInput(req.body, { partial: true });
    const error = validate(fields, { partial: true });
    if (error) {
      return res.status(400).json({ error });
    }

    const item = await getStore().portfolio.set(existing._id, fields);
    res.json({ item });
  } catch (error) {
    console.error('[Portfolio] Update error:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
}

/**
 * DELETE /portfolio/:id - remove a project
 */
export async function deletePortfolioItem(req, res) {
  try {
    const existing = await findOwnedItem(req);
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await getStore().portfolio.remove(existing._id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Portfolio] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
}

/**
 * GET /portfolio/public/:username - public projects, no auth
 */
export async function getPublicPortfolio(req, res) {
  try {
    const { users, portfolio } = getStore();
    const user = await users.findByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const items = await portfolio.list({
      where: { userId: ownerId(user) },
      limit: MAX_ITEMS_PER_USER,
    });
    const publicItems = sortPortfolioItems(items.filter((item) => item.isPublic)).map(toPublicItem);

    res.set('Cache-Control', 'no-cache');
    res.json({ owner: { username: user.username }, items: publicItems });
  } catch (error) {
    console.error('[Portfolio] Public portfolio error:', error);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
}
