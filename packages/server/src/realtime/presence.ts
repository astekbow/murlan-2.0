// Tracks which users currently have at least one live socket. Shared between the
// gateway (writes on connect/disconnect) and the friends routes (reads online
// status). A presence-membership SET (idempotent add): the gateway calls add()
// on every connect and remove() only on the LAST socket's disconnect, so add()
// MUST be idempotent — a ref-count would otherwise climb with each extra tab and
// never return to zero (users would show online forever after closing them).
export class Presence {
  private onlineSet = new Set<string>();

  add(userId: string): void {
    this.onlineSet.add(userId);
  }
  remove(userId: string): void {
    this.onlineSet.delete(userId);
  }
  isOnline(userId: string): boolean {
    return this.onlineSet.has(userId);
  }
  online(): string[] {
    return [...this.onlineSet];
  }
}
