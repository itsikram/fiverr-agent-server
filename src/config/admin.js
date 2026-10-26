// Accounts that are always admins, whatever role is stored for them.
const ADMIN_EMAILS = new Set(['mdikram295@gmail.com']);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
}

/**
 * Promote a built-in admin account whose stored role is not "admin".
 * Mutates and returns `user`.
 */
export async function ensureAdminRole(users, user) {
  if (user && user.role !== 'admin' && isAdminEmail(user.email)) {
    await users.update({ id: user._id }, { role: 'admin' });
    user.role = 'admin';
  }
  return user;
}
