// Extension via events (CLAUDE.md rule 8): after a posting or void is
// committed, the ledger service announces it here. Future modules subscribe
// instead of editing existing ones.

export interface LedgerEventDetail {
  entryId: number;
  sourceType: string;
  sourceId: string | null;
}

export const ledgerEvents = new EventTarget();

/** posted, voided, and where the company allows changing posted entries (GL-6), changed and deleted */
export type LedgerEventType = 'posted' | 'voided' | 'changed' | 'deleted';

export function emitLedgerEvent(type: LedgerEventType, detail: LedgerEventDetail) {
  ledgerEvents.dispatchEvent(new CustomEvent<LedgerEventDetail>(type, { detail }));
}
