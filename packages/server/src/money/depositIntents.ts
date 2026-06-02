// Records a deposit intent (who asked to deposit, under which providerRef) so
// the webhook can BIND the credit to that user instead of trusting a userId
// from the (signed) webhook body. Even if the signing secret leaked, money can
// only ever land on the account that actually initiated the deposit.

export interface DepositIntentRecord {
  providerRef: string;
  userId: string;
  amountCents: number;
  currency: string;
  createdAt: number;
}

export interface DepositIntentRepository {
  save(r: Omit<DepositIntentRecord, 'createdAt'>): Promise<void>;
  find(providerRef: string): Promise<DepositIntentRecord | null>;
}

export class InMemoryDepositIntents implements DepositIntentRepository {
  private byRef = new Map<string, DepositIntentRecord>();

  async save(r: Omit<DepositIntentRecord, 'createdAt'>): Promise<void> {
    this.byRef.set(r.providerRef, { ...r, createdAt: Date.now() });
  }

  async find(providerRef: string): Promise<DepositIntentRecord | null> {
    const r = this.byRef.get(providerRef);
    return r ? { ...r } : null;
  }
}
