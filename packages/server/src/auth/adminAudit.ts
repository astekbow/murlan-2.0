// Append-only audit trail for privileged admin actions (balance adjustments,
// KYC changes, withdrawal approve/reject). The single most important fraud/AML
// control: every privileged money/identity change records WHO did it, to WHOM,
// for HOW MUCH, and WHY. Never updated or deleted.

export type AdminActionType = 'balance_adjust' | 'kyc_set' | 'role_set' | 'permissions_set' | 'withdrawal_approve' | 'withdrawal_reject' | 'profile_self_update' | 'support_resolve' | 'account_state_set' | 'chat_moderation' | 'match_void' | 'tournament_create' | 'tournament_report' | 'tournament_confirm' | 'tournament_cancel' | 'account_self_delete';

export interface AdminActionRecord {
  id: string;
  adminId: string;
  action: AdminActionType;
  targetUserId: string | null;
  amountCents: number | null;
  detail: string | null;
  createdAt: number;
}

export interface NewAdminAction {
  adminId: string;
  action: AdminActionType;
  targetUserId?: string | null;
  amountCents?: number | null;
  detail?: string | null;
}

export interface AdminAuditRepository {
  record(a: NewAdminAction): Promise<void>;
  list(limit?: number): Promise<AdminActionRecord[]>;
  /**
   * Sum the ABSOLUTE amountCents of one admin's `balance_adjust` actions since `sinceMs`
   * (admin-6 rolling-24h governance cap). Credits and debits both count toward the cap
   * (|delta|), so an admin can't structure around it by alternating sign. The store-level
   * aggregate is authoritative (never the bounded `list()`).
   */
  sumAdjustmentsBy(adminId: string, sinceMs: number): Promise<number>;
}

export class InMemoryAdminAudit implements AdminAuditRepository {
  private rows: AdminActionRecord[] = [];
  private seq = 0;

  async record(a: NewAdminAction): Promise<void> {
    this.rows.push({
      id: `aa_${(this.seq += 1)}`,
      adminId: a.adminId,
      action: a.action,
      targetUserId: a.targetUserId ?? null,
      amountCents: a.amountCents ?? null,
      detail: a.detail ?? null,
      createdAt: Date.now(),
    });
  }
  async list(limit = 200): Promise<AdminActionRecord[]> {
    return this.rows.slice(-limit).reverse();
  }
  async sumAdjustmentsBy(adminId: string, sinceMs: number): Promise<number> {
    return this.rows
      .filter((r) => r.adminId === adminId && r.action === 'balance_adjust' && r.createdAt >= sinceMs)
      .reduce((s, r) => s + Math.abs(r.amountCents ?? 0), 0);
  }
}
