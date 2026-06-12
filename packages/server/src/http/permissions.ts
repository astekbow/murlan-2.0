// ============================================================================
// MURLAN — Granular admin permissions (RBAC)
// ----------------------------------------------------------------------------
// Layers fine-grained scopes ON TOP of the existing admin gate, without breaking
// the single-admin model. The rule, by design, is backward-compatible:
//
//   • requireAdmin still runs first — a non-admin is rejected exactly as before.
//   • An admin whose `permissions` list is EMPTY is a FULL admin (every scope).
//     Every existing admin row defaults to [] → unchanged, full access.
//   • An admin with a NON-EMPTY list is restricted to exactly those scopes.
//
// So scoping is strictly opt-in per admin: the owner stays all-powerful, and a
// "support only" admin can be created by assigning them a narrow scope set.
// ============================================================================

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import { requireAdmin } from './authRoutes.ts';

/** The fixed set of grantable admin scopes. Keep in sync with the client picker. */
export const ADMIN_PERMISSIONS = [
  'adjust_balance',       // credit/debit a user's wallet
  'approve_withdrawals',  // approve / reject withdrawals
  'manage_accounts',      // KYC + account-state (freeze/suspend/ban)
  'manage_admins',        // promote/demote + assign permission scopes
  'moderate_chat',        // mute/unmute, review reports
  'void_matches',         // void an in-progress staked match (refund)
  'view_revenue',         // revenue + breakdown reporting
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export function isAdminPermission(v: unknown): v is AdminPermission {
  return typeof v === 'string' && (ADMIN_PERMISSIONS as readonly string[]).includes(v);
}

/**
 * True if an admin holding `granted` scopes may perform an action needing
 * `needed`. An empty `granted` list means "full admin" (back-compat).
 */
export function hasPermission(granted: string[] | undefined, needed: AdminPermission): boolean {
  const list = granted ?? [];
  return list.length === 0 || list.includes(needed);
}

/**
 * Like requireAdmin, but also requires the admin to hold a specific scope. Sends
 * 403 (forbidden) and returns null when the caller is not an admin, or is a
 * SCOPED admin lacking `permission`. A full admin (empty scopes) always passes.
 */
export function requirePermission(auth: AuthService, permission: AdminPermission) {
  const base = requireAdmin(auth);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; username: string } | null> => {
    const caller = await base(req, reply);
    if (!caller) return null; // base already sent 401/403
    const user = await auth.getUser(caller.userId);
    // Fail CLOSED if the user vanished between the admin check and here (a hard
    // delete mid-request) — an absent user must never be treated as a full admin.
    if (!user || !hasPermission(user.permissions, permission)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'Nuk ke lejen e nevojshme për këtë veprim.' } });
      return null;
    }
    return caller;
  };
}
