// Extension via events (CLAUDE.md rule 8): after a posting or void is
// committed, the ledger service announces it here. Future modules subscribe
// instead of editing existing ones.

export interface LedgerEventDetail {
  entryId: number;
  sourceType: string;
  sourceId: string | null;
}

export const ledgerEvents = new EventTarget();

export function emitLedgerEvent(type: 'posted' | 'voided', detail: LedgerEventDetail) {
  ledgerEvents.dispatchEvent(new CustomEvent<LedgerEventDetail>(type, { detail }));
}
