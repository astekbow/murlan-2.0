// REST client for auth. The refresh token is an httpOnly cookie (sent
// automatically with credentials: 'include'); the access token is held in
// memory by the auth store and passed as a Bearer header.

import type {
  MatchType, RankedProfileDTO, RankedLeaderboardRow, SeasonDTO, TierInfo, RankedTierKey,
  ReplayDTO, ReplayActionDTO, ReplayGameDTO, VipStatusDTO, VipTierInfo,
  ClubSummaryDTO, ClubDetailDTO, ChatMessageDTO,
} from '@murlan/shared';
import { errText } from './errors.ts';

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: string;
  permissions?: string[]; // granular admin scopes; empty/absent = full admin
  balanceCents: number;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code = 'error', public readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
}

// ---------- Session bridge (set by the auth store) --------------------------
// The access token has a short TTL. To keep the app alive past it, a 401 on an
// authenticated call triggers ONE silent refresh + retry, and the socket layer
// can request the current/fresh token. The auth store registers the hooks so
// this module stays free of a circular store import.
let onTokenRefreshed: ((token: string) => void) | null = null;
let onSessionLost: (() => void) | null = null;
export function registerSessionHandlers(h: { onToken: (t: string) => void; onLost: () => void }): void {
  onTokenRefreshed = h.onToken;
  onSessionLost = h.onLost;
}

let refreshInFlight: Promise<string> | null = null;
/** Single-flight access-token refresh from the httpOnly refresh cookie. */
export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = rawRequest<AuthResponse>('/auth/refresh', { method: 'POST' })
      .then((res) => {
        onTokenRefreshed?.(res.accessToken);
        return res.accessToken;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** A single fetch with no auto-refresh — used by refresh itself and internally. */
async function rawRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // fetch rejects only on a network/CORS failure — distinguish from a 4xx/5xx.
    throw new ApiError(errText('network', 'Lidhja me serverin dështoi. Kontrollo internetin.'), 'network', 0);
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    // Localize by code (server stays source of truth for the code); fall back to the
    // server's own message (it may carry specifics like an amount), then a generic.
    // No client-invented 'error' code here — that collides with the real 'error' code
    // (club-chat send failure). An uncoded response → errText's err.generic.
    const code = data?.error?.code ?? (res.status === 429 ? 'rate_limited' : undefined);
    throw new ApiError(errText(code, data?.error?.message), code ?? 'error', res.status);
  }
  return data as T;
}

async function request<T>(path: string, opts: RequestOptions = {}, _retried = false): Promise<T> {
  try {
    return await rawRequest<T>(path, opts);
  } catch (e) {
    // An authenticated call that 401s while we hold a (now-expired) access token:
    // refresh once from the cookie and retry with the new token. Never recurse on
    // the refresh endpoint itself, and only retry once.
    const is401 = e instanceof ApiError && e.status === 401;
    if (is401 && opts.token && !_retried && path !== '/auth/refresh') {
      try {
        const newToken = await refreshAccessToken();
        return await request<T>(path, { ...opts, token: newToken }, true);
      } catch {
        onSessionLost?.();
        throw new ApiError(errText('session_expired', 'Sesioni skadoi — hyr përsëri.'), 'session_expired', 401);
      }
    }
    throw e;
  }
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}
export interface LoginInput {
  email: string;
  password: string;
}

export const authApi = {
  register: (body: RegisterInput) => request<AuthResponse>('/auth/register', { method: 'POST', body }),
  login: (body: LoginInput) => request<AuthResponse>('/auth/login', { method: 'POST', body }),
  refresh: () => request<AuthResponse>('/auth/refresh', { method: 'POST' }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  me: (token: string) => request<{ user: PublicUser }>('/auth/me', { method: 'GET', token }),
  forgotPassword: (email: string) => request<{ ok: boolean }>('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token: string, password: string) => request<{ ok: boolean }>('/auth/reset-password', { method: 'POST', body: { token, password } }),
  confirmEmail: (token: string) => request<{ ok: boolean }>('/auth/verify-email/confirm', { method: 'POST', body: { token } }),
  requestEmailVerification: (token: string) => request<{ ok: boolean }>('/auth/verify-email/request', { method: 'POST', token }),
};

// ---------- Social: profiles, leaderboard, friends (Phase 5) ----------------

export interface LevelInfo {
  level: number;
  intoLevel: number;
  levelSpan: number;
  pct: number;
}
export interface Profile {
  id: string;
  username: string;
  avatar: string | null;
  xp: number;
  level: number;
  levelInfo: LevelInfo;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  biggestPotCents: number;
  currentStreak: number;
}
export interface LeaderboardRow {
  rank: number;
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  xp: number;
  wins: number;
  gamesPlayed: number;
  winRate: number;
}
export interface FriendEntry {
  id: string;
  status: 'pending' | 'accepted' | 'blocked';
  direction: 'incoming' | 'outgoing' | 'friends' | 'blocked';
  online: boolean;
  user: { id: string; username: string; avatar: string | null; level: number };
}

export const profileApi = {
  get: (userId: string) => request<{ profile: Profile }>(`/profile/${userId}`),
  me: (token: string) => request<{ profile: Profile }>('/me/profile', { token }),
  setAvatar: (token: string, avatar: string) => request<{ profile: Profile }>('/me/avatar', { method: 'POST', token, body: { avatar } }),
  leaderboard: () => request<{ rows: LeaderboardRow[] }>('/leaderboard'),
};

export const friendsApi = {
  list: (token: string) => request<{ friends: FriendEntry[] }>('/friends', { token }),
  request: (token: string, username: string) => request<{ ok: boolean }>('/friends/request', { method: 'POST', token, body: { username } }),
  respond: (token: string, id: string, accept: boolean) => request<{ ok: boolean }>(`/friends/${id}/respond`, { method: 'POST', token, body: { accept } }),
  remove: (token: string, id: string) => request<{ ok: boolean }>(`/friends/${id}`, { method: 'DELETE', token }),
  // Block/unblock are keyed by the target USER id (works even for non-friends).
  block: (token: string, userId: string) => request<{ ok: boolean }>(`/friends/${userId}/block`, { method: 'POST', token }),
  unblock: (token: string, userId: string) => request<{ ok: boolean }>(`/friends/${userId}/unblock`, { method: 'POST', token }),
};

// ---------- Rewards / cosmetics (Phase 6, §2.6) — XP/cosmetic only ----------

export type CosmeticType = 'cardBack' | 'tableFelt';
export interface RewardChallenge {
  id: string; title: string; goal: number; progress: number; done: boolean; claimed: boolean; rewardXp: number;
}
export interface ShopItem {
  id: string; name: string; type: CosmeticType; cost: number; owned: boolean;
}
export interface RewardsStatus {
  enabled: boolean;
  xp: number;
  level: number;
  daily: { canClaim: boolean; streak: number; rewardXp: number };
  challenges: RewardChallenge[];
  shop: ShopItem[];
  equipped: { cardBack: string | null; tableFelt: string | null };
}

export const rewardsApi = {
  status: (token: string) => request<{ status: RewardsStatus }>('/rewards', { token }),
  claimDaily: (token: string) => request<{ rewardXp: number; streak: number }>('/rewards/daily', { method: 'POST', token }),
  claimChallenge: (token: string, id: string) => request<{ rewardXp: number }>(`/rewards/challenge/${id}`, { method: 'POST', token }),
  buy: (token: string, id: string) => request<{ ok: boolean }>('/shop/buy', { method: 'POST', token, body: { id } }),
  equip: (token: string, id: string) => request<{ ok: boolean }>('/cosmetics/equip', { method: 'POST', token, body: { id } }),
};

// ---------- Ranked / seasons (competitive MMR — never cashable) -------------

export const rankedApi = {
  tiers: () => request<{ tiers: TierInfo[] }>('/ranked/tiers'),
  season: () => request<{ season: SeasonDTO | null }>('/ranked/season'),
  leaderboard: () => request<{ rows: RankedLeaderboardRow[] }>('/ranked/leaderboard'),
  me: (token: string) => request<{ ranked: RankedProfileDTO }>('/ranked/me', { token }),
};

export type { RankedProfileDTO, RankedLeaderboardRow, SeasonDTO, TierInfo, RankedTierKey };

// ---------- Replay / provably-fair verification (public) --------------------

export const replayApi = {
  get: (matchId: string) => request<ReplayDTO>(`/replay/${encodeURIComponent(matchId)}`),
};

export type { ReplayDTO, ReplayActionDTO, ReplayGameDTO };

// ---------- Wallet & account ------------------------------------------------

export type TransactionType = 'deposit' | 'withdrawal' | 'bet' | 'payout' | 'rake' | 'purchase' | 'admin_adjust';

export interface Transaction {
  id: string;
  type: TransactionType;
  amountCents: number;
  currency: string;
  status: string;
  providerRef: string | null;
  matchId: string | null;
  reason: string | null;
  createdAt: number;
}

export interface WithdrawalRecord {
  id: string;
  amountCents: number;
  destination: string;
  status: 'pending' | 'completed' | 'rejected';
  createdAt: number;
}

export interface DepositIntent {
  providerRef: string;
  payAddress: string;
  amountCents: number;
}

export interface ComplianceProfile {
  kycStatus: 'none' | 'pending' | 'verified';
  dateOfBirth: string | null;
  country: string | null;
  selfExcludedUntil: number | null;
}

export const walletApi = {
  balance: (token: string) => request<{ balanceCents: number }>('/wallet', { token }),
  transactions: (token: string) => request<{ transactions: Transaction[] }>('/wallet/transactions', { token }),
  deposit: (token: string, amountCents: number) => request<DepositIntent>('/wallet/deposit', { method: 'POST', token, body: { amountCents } }),
  withdraw: (token: string, amountCents: number, destination: string) =>
    request<{ withdrawal: WithdrawalRecord }>('/wallet/withdraw', { method: 'POST', token, body: { amountCents, destination } }),
  withdrawals: (token: string) => request<{ withdrawals: WithdrawalRecord[] }>('/wallet/withdrawals', { token }),
  // Fee-free USDT-TRC20 deposits: fetch our receiving address, then submit a TxID.
  depositAddress: (token: string) => request<{ address: string | null; currency?: string; network?: string }>('/wallet/deposit/address', { token }),
  submitDepositTxid: (token: string, txId: string) =>
    request<{ ok: boolean; amountCents: number; balanceCents: number }>('/wallet/deposit/txid', { method: 'POST', token, body: { txId } }),
};

export interface RgLimits {
  dailyDepositLimitCents: number | null;
  dailyLossLimitCents: number | null;
}

export const accountApi = {
  get: (token: string) => request<{ profile: ComplianceProfile }>('/account', { token }),
  setProfile: (token: string, body: { dateOfBirth?: string; country?: string }) =>
    request<{ user: PublicUser }>('/account/profile', { method: 'POST', token, body }),
  selfExclude: (token: string, days: number) =>
    request<{ ok: boolean; selfExcludedUntil: number }>('/account/self-exclude', { method: 'POST', token, body: { days } }),
  getLimits: (token: string) => request<{ limits: RgLimits }>('/account/limits', { token }),
  setLimits: (token: string, body: Partial<RgLimits>) =>
    request<{ limits: RgLimits }>('/account/limits', { method: 'POST', token, body }),
  subscribePush: (token: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: boolean }>('/account/push-subscription', { method: 'POST', token, body: sub }),
  unsubscribePush: (token: string, endpoint: string) =>
    request<{ ok: boolean }>('/account/push-subscription', { method: 'DELETE', token, body: { endpoint } }),
};

// ---------- Clubs (social) --------------------------------------------------

export const clubsApi = {
  list: (token: string) => request<{ clubs: ClubSummaryDTO[] }>('/clubs', { token }),
  mine: (token: string) => request<{ club: ClubDetailDTO | null }>('/clubs/me', { token }),
  get: (token: string, id: string) => request<{ club: ClubDetailDTO }>(`/clubs/${encodeURIComponent(id)}`, { token }),
  create: (token: string, name: string, tag: string, priv?: boolean) => request<{ club: ClubDetailDTO }>('/clubs', { method: 'POST', token, body: { name, tag, private: priv } }),
  join: (token: string, id: string) => request<{ club: ClubDetailDTO }>(`/clubs/${encodeURIComponent(id)}/join`, { method: 'POST', token }),
  joinByCode: (token: string, code: string) => request<{ club: ClubDetailDTO }>('/clubs/joinByCode', { method: 'POST', token, body: { code } }),
  leave: (token: string) => request<{ ok: boolean }>('/clubs/leave', { method: 'POST', token }),
  messages: (token: string, clubId: string) => request<{ messages: ChatMessageDTO[] }>(`/clubs/${encodeURIComponent(clubId)}/messages`, { token }),
  report: (token: string, messageId: string, reason: string) => request<{ ok: boolean }>(`/clubs/messages/${encodeURIComponent(messageId)}/report`, { method: 'POST', token, body: { reason } }),
  mute: (token: string, userId: string, durationMs?: number, reason?: string) => request<{ ok: boolean }>('/clubs/mute', { method: 'POST', token, body: { userId, durationMs, reason } }),
};
export type { ClubSummaryDTO, ClubDetailDTO, ChatMessageDTO };

// ---------- VIP / loyalty ---------------------------------------------------

export const vipApi = {
  status: (token: string) => request<{ vip: VipStatusDTO }>('/vip', { token }),
  tiers: () => request<{ tiers: VipTierInfo[] }>('/vip/tiers'),
};
export type { VipStatusDTO, VipTierInfo };

// ---------- Support / disputes ----------------------------------------------

export type SupportCategory = 'match' | 'payment' | 'account' | 'other';
export interface SupportTicket {
  id: string;
  userId: string;
  category: SupportCategory;
  subject: string;
  message: string;
  status: 'open' | 'resolved' | 'closed';
  matchId: string | null;
  adminNote: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export const supportApi = {
  create: (token: string, body: { category: SupportCategory; subject: string; message: string; matchId?: string }) =>
    request<{ ticket: SupportTicket }>('/support/tickets', { method: 'POST', token, body }),
  mine: (token: string) => request<{ tickets: SupportTicket[] }>('/support/tickets', { token }),
};

// ---------- Admin ------------------------------------------------------------

export interface AdminUser extends PublicUser {
  kycStatus: 'none' | 'pending' | 'verified';
}
export interface RevenueBreakdown {
  totalRakeCents: number;
  rakeCount: number;
  byDay: Array<{ date: string; rakeCents: number; matchCount: number }>;
  byType: Array<{ type: string; rakeCents: number; matchCount: number }>;
  payoutLiabilityCents: number;
}
export interface AdminWithdrawal {
  id: string;
  userId: string;
  amountCents: number;
  destination: string;
  status: string;
  createdAt: number;
  username?: string | null;
  kycStatus?: string | null;
}
export interface AdminMatch {
  roomId: string;
  matchId: string | null;
  type: string;
  stakeCents: number;
  target: number;
  players: Array<{ seat: number; username: string | null; connected: boolean }>;
}
export interface AdminActionRecord {
  id: string;
  adminId: string;
  action: string;
  targetUserId: string | null;
  amountCents: number | null;
  detail: string | null;
  createdAt: number;
}
export type AdminAccountState = 'active' | 'frozen' | 'suspended' | 'banned';

export interface AdminChatReport {
  id: string;
  messageId: string;
  clubId: string;
  reporterId: string;
  reason: string;
  reviewed: boolean;
  createdAt: number;
}

export const adminApi = {
  users: (token: string) => request<{ users: AdminUser[] }>('/admin/users', { token }),
  matches: (token: string) => request<{ matches: AdminMatch[] }>('/admin/matches', { token }),
  withdrawals: (token: string) => request<{ withdrawals: AdminWithdrawal[] }>('/admin/withdrawals', { token }),
  adjust: (token: string, id: string, deltaCents: number, reason: string) =>
    request<{ balanceCents: number }>(`/admin/users/${id}/adjust`, { method: 'POST', token, body: { deltaCents, reason } }),
  setKyc: (token: string, id: string, status: 'none' | 'pending' | 'verified') =>
    request<{ user: AdminUser }>(`/admin/users/${id}/kyc`, { method: 'POST', token, body: { status } }),
  approveWithdrawal: (token: string, id: string) => request<unknown>(`/admin/withdrawals/${id}/approve`, { method: 'POST', token }),
  rejectWithdrawal: (token: string, id: string) => request<unknown>(`/admin/withdrawals/${id}/reject`, { method: 'POST', token }),
  setRole: (token: string, id: string, role: 'user' | 'admin') =>
    request<{ user: AdminUser }>(`/admin/users/${id}/role`, { method: 'POST', token, body: { role } }),
  setPermissions: (token: string, id: string, permissions: string[]) =>
    request<{ user: AdminUser }>(`/admin/users/${id}/permissions`, { method: 'POST', token, body: { permissions } }),
  voidMatch: (token: string, roomId: string, reason: string) =>
    request<{ ok: boolean; matchId: string | null; refunded: boolean }>(`/admin/matches/${encodeURIComponent(roomId)}/void`, { method: 'POST', token, body: { reason } }),
  revenue: (token: string) => request<{ totalRakeCents: number; rakeCount: number }>('/admin/revenue', { token }),
  revenueBreakdown: (token: string) => request<RevenueBreakdown>('/admin/revenue/breakdown', { token }),
  audit: (token: string) => request<{ actions: AdminActionRecord[] }>('/admin/audit', { token }),
  support: (token: string) => request<{ tickets: SupportTicket[] }>('/admin/support', { token }),
  resolveTicket: (token: string, id: string, status: 'resolved' | 'closed', adminNote?: string) =>
    request<{ ticket: SupportTicket }>(`/admin/support/${id}/resolve`, { method: 'POST', token, body: { status, adminNote } }),
  setAccountState: (token: string, id: string, state: AdminAccountState, reason?: string, durationMs?: number) =>
    request<{ user: AdminUser }>(`/admin/users/${id}/account-state`, { method: 'POST', token, body: { state, reason, durationMs } }),
  transactions: (token: string, id: string) => request<{ transactions: Transaction[] }>(`/admin/users/${id}/transactions`, { token }),
  chatReports: (token: string) => request<{ reports: AdminChatReport[] }>('/admin/chat-reports', { token }),
  muteUser: (token: string, id: string, durationMs?: number, reason?: string) =>
    request<{ ok: boolean }>(`/admin/users/${id}/mute`, { method: 'POST', token, body: { durationMs, reason } }),
  unmuteUser: (token: string, id: string) =>
    request<{ ok: boolean }>(`/admin/users/${id}/unmute`, { method: 'POST', token, body: {} }),
};

// ----- Tournaments ---------------------------------------------------------
export interface BracketMatchDTO { round: number; index: number; aUserId: string | null; bUserId: string | null; winnerId: string | null }
export interface TournamentDTO {
  id: string; name: string; buyInCents: number; capacity: number;
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  playerIds: string[]; bracket: BracketMatchDTO[]; prizePoolCents: number; winnerId: string | null; createdAt: number;
}
export const tournamentsApi = {
  list: (token: string) => request<{ tournaments: TournamentDTO[] }>('/tournaments', { token }),
  get: (token: string, id: string) => request<{ tournament: TournamentDTO }>(`/tournaments/${encodeURIComponent(id)}`, { token }),
  register: (token: string, id: string) => request<{ tournament: TournamentDTO }>(`/tournaments/${encodeURIComponent(id)}/register`, { method: 'POST', token }),
  create: (token: string, name: string, buyInCents: number, capacity: 2 | 4 | 8) =>
    request<{ tournament: TournamentDTO }>('/tournaments', { method: 'POST', token, body: { name, buyInCents, capacity } }),
  report: (token: string, id: string, round: number, index: number, winnerId: string) =>
    request<{ tournament: TournamentDTO }>(`/tournaments/${encodeURIComponent(id)}/report`, { method: 'POST', token, body: { round, index, winnerId } }),
  cancel: (token: string, id: string) => request<{ tournament: TournamentDTO }>(`/tournaments/${encodeURIComponent(id)}/cancel`, { method: 'POST', token }),
};

// Re-export so the lobby create form can type its stake/room-type field.
export type { MatchType };
