import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { blankPayee } from '../ledger/payees';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

describe('session: bills and bill payments (AP-2, AP-3)', () => {
  it('keeps a bill’s receipt; a payment posts and voids through the ledger, announcing both', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'pw', 'PC');
    expect(session.modules().bills).toBe(false);
    session.setModule('bills', true);
    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const vendor = session.createPayee({ ...blankPayee('Georgia Power'), termsDays: 15 });
    const bill = session.createBill({
      vendorId: vendor,
      number: '88-1',
      date: '2026-01-05',
      dueDate: null,
      termsDays: 15,
      memo: null,
      lines: [{ accountId: id('Utilities'), description: 'January', amount: 212_40 }],
    });
    const file = await session.addAttachment('bill', bill, new File(['pdf'], 'power.pdf'));
    expect(session.billFiles(bill).map((f) => f.id)).toEqual([file.id]);
    expect(session.bill(bill).attachments).toBe(1);
    await expect(session.addAttachment('bill', 'nope', new File(['x'], 'x.pdf'))).rejects.toThrow(
      /That bill does not exist/,
    );

    const seen: string[] = [];
    const listen = (e: Event) =>
      seen.push(`${e.type}:${(e as CustomEvent<LedgerEventDetail>).detail.sourceType}`);
    ledgerEvents.addEventListener('posted', listen);
    ledgerEvents.addEventListener('voided', listen);
    try {
      const { paymentId } = await session.payBills({
        vendorId: vendor,
        date: '2026-01-18',
        accountId: id('Checking'),
        method: 'Check',
        ref: '1042',
        memo: null,
        applications: [{ billId: bill, amount: 212_40 }],
      });
      expect(session.bill(bill)).toMatchObject({ state: 'paid', owed: 0 });
      expect(session.billsDue().owed).toBe(0);
      await session.voidBillPayment(paymentId, null);
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
      ledgerEvents.removeEventListener('voided', listen);
    }
    expect(seen).toEqual(['posted:bill_payment', 'voided:bill_payment']);
    expect(session.bill(bill).owed).toBe(212_40);
    // A bill that had payments stays; one entered by mistake can go, unlinking its receipt
    expect(() => session.deleteBill(bill)).toThrow(/void it instead/);
    const mistake = session.createBill({
      ...session.bill(bill),
      lines: [{ accountId: id('Utilities'), description: null, amount: 5_00 }],
    });
    await session.addAttachment('bill', mistake, new File(['x'], 'x.pdf'));
    session.deleteBill(mistake);
    expect(session.billFiles(mistake)).toEqual([]);
  });
});
