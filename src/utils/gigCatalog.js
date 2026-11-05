/**
 * Seller gig catalogs sent by the browser extension (gig titles, packages,
 * prices, delivery, revisions, extras, FAQ). The app's AI uses them to know
 * which gig a client wrote about and how to price the work.
 *
 * Everything is re-validated here: only known fields are kept, strings and
 * lists are capped, and numbers/URLs are coerced, so a malformed or oversized
 * payload can't bloat memory, the database, or app broadcasts.
 */

export const GIG_CATALOG_DOC_PREFIX = "gig-catalog:";

const LIMITS = {
  gigs: 30,
  packages: 6,
  features: 25,
  extras: 20,
  faq: 10,
  errors: 10,
  includes: 12,
};

const text = (value, max) => {
  if (value === null || value === undefined || typeof value === "object") {
    return "";
  }
  const str = String(value).replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max) : str;
};

const amount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return null;
  return Math.round(n * 100) / 100;
};

const days = (value) => {
  const n = amount(value);
  return n === null || n > 365 ? null : n;
};

const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

export const normalizeSellerUsername = (value) => {
  const username = text(value, 60).replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_.]{2,60}$/.test(username) ? username : "";
};

const httpsUrl = (value, hostPattern) => {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    if (hostPattern && !hostPattern.test(url.hostname)) return "";
    return url.toString().slice(0, 600);
  } catch (_) {
    return "";
  }
};

const gigUrl = (value) => {
  const url = httpsUrl(value, /(^|\.)fiverr\.com$/i);
  if (!url) return "";
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
};

const slug = (value) => {
  const str = text(value, 200).toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(str) ? str : "";
};

const isoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
};

const sanitizeFeature = (feature) => {
  if (!feature || typeof feature !== "object") return null;
  const name = text(feature.name, 120);
  if (!name) return null;
  const out = { name };
  const value = text(feature.value, 60);
  if (value) out.value = value;
  if (typeof feature.included === "boolean") out.included = feature.included;
  return out;
};

const sanitizePackage = (pkg) => {
  if (!pkg || typeof pkg !== "object") return null;
  const tier = text(pkg.tier, 40);
  const name = text(pkg.name, 80) || tier;
  if (!name) return null;
  const out = {
    tier: tier || name,
    name,
    description: text(pkg.description, 400),
    price: amount(pkg.price),
    deliveryDays: days(pkg.deliveryDays),
    revisions: text(pkg.revisions, 30) || null,
    features: list(pkg.features, LIMITS.features)
      .map(sanitizeFeature)
      .filter(Boolean),
  };
  if (pkg.extraFast && typeof pkg.extraFast === "object") {
    const price = amount(pkg.extraFast.price);
    if (price !== null) {
      out.extraFast = { price, deliveryDays: days(pkg.extraFast.deliveryDays) };
    }
  }
  return out;
};

const sanitizeExtra = (extra) => {
  if (!extra || typeof extra !== "object") return null;
  const title = text(extra.title, 120);
  if (!title) return null;
  return {
    title,
    price: amount(extra.price),
    deliveryDays: days(extra.deliveryDays),
  };
};

const sanitizeFaq = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  const question = text(entry.question, 200);
  const answer = text(entry.answer, 400);
  return question && answer ? { question, answer } : null;
};

const sanitizeGig = (gig) => {
  if (!gig || typeof gig !== "object") return null;
  const url = gigUrl(gig.url);
  const gigSlug = slug(gig.slug) || slug(url.split("/").pop());
  if (!url && !gigSlug) return null;
  const currency = text(gig.currency, 3).toUpperCase();
  const rating = amount(gig.rating);
  const gigId = text(gig.gigId, 20);
  return {
    gigId: /^\d+$/.test(gigId) ? gigId : null,
    slug: gigSlug || null,
    owner: normalizeSellerUsername(gig.owner) || null,
    url,
    title: text(gig.title, 200),
    category: text(gig.category, 160),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    startingPrice: amount(gig.startingPrice),
    rating: rating !== null && rating <= 5 ? rating : null,
    reviewsCount: amount(gig.reviewsCount),
    description: text(gig.description, 2500),
    packages: list(gig.packages, LIMITS.packages)
      .map(sanitizePackage)
      .filter(Boolean),
    extras: list(gig.extras, LIMITS.extras).map(sanitizeExtra).filter(Boolean),
    faq: list(gig.faq, LIMITS.faq).map(sanitizeFaq).filter(Boolean),
    packagesText: text(gig.packagesText, 2500),
    imageUrl: httpsUrl(gig.imageUrl) || null,
    error: text(gig.error, 300) || null,
  };
};

/** Validated catalog, or null when the payload has no usable seller. */
export const sanitizeGigCatalog = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const sellerUsername = normalizeSellerUsername(raw.sellerUsername);
  if (!sellerUsername) return null;
  const seen = new Set();
  const gigs = list(raw.gigs, LIMITS.gigs)
    .map(sanitizeGig)
    .filter((gig) => {
      if (!gig) return false;
      const key = gig.slug || gig.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    sellerUsername,
    extractedAt: isoDate(raw.extractedAt),
    gigs,
    errors: list(raw.errors, LIMITS.errors)
      .map((error) => text(error, 300))
      .filter(Boolean),
    partial: raw.partial === true,
  };
};

/** Gig URLs the app may pass to the extension (owner gig pages only). */
export const sanitizeGigUrls = (value) =>
  list(value, 50)
    .map(gigUrl)
    .filter((url) => url && url.split("/").length === 5);
