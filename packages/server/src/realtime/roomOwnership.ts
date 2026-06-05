// ============================================================================
// MURLAN — Room ownership registry (multi-instance groundwork)
// ----------------------------------------------------------------------------
// Which server instance authoritatively owns a given room/match. The gateway
// guards room joins with this so a socket landing on a NON-owning instance is
// rejected with a reconnect hint (instead of spinning up a divergent authoritative
// copy of the same match — the core multi-instance hazard).
//
// SINGLE-INSTANCE: the in-memory impl is a no-op — `isForeign` is always false,
// so the guard never fires and behaviour is unchanged. The interface is the seam
// for a Redis-backed impl (claim with `SET NX` + TTL/heartbeat; a pub/sub-synced
// local cache keeps `isForeign` synchronous) that makes horizontal scaling safe.
// Until that exists, run a single replica (see DEPLOYMENT.md §7). Money is already
// safe across instances (DB tx + idempotent providerRef + the recovery sweep).
// ============================================================================

export interface RoomOwnership {
  /** Stable id of THIS process/instance. */
  readonly instanceId: string;
  /** Record that this instance owns `roomId` (called when a room is created). */
  claim(roomId: string): void;
  /** Forget ownership of `roomId` (called when the room closes). */
  release(roomId: string): void;
  /** True iff `roomId` is owned by a DIFFERENT instance. Always false single-instance. */
  isForeign(roomId: string): boolean;
}

/** Single-instance ownership: tracks locally-owned rooms; no room is ever foreign. */
export class InMemoryRoomOwnership implements RoomOwnership {
  readonly instanceId: string;
  private readonly owned = new Set<string>();

  constructor(instanceId = 'local') {
    this.instanceId = instanceId;
  }

  claim(roomId: string): void {
    this.owned.add(roomId);
  }
  release(roomId: string): void {
    this.owned.delete(roomId);
  }
  /** In a single process there are no other instances, so nothing is ever foreign. */
  isForeign(_roomId: string): boolean {
    return false;
  }
}
