import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

describe('session: invoices and payments (AR-4, AR-7)', () => {
  it('starts with sales off; a payment posts and voids through the ledger, announcing both', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'pw', 'PC');
    expect(session.modules().sales).toBe(false);
    session.setModule('sales', true);

    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const customer = session.createPayee({
      name: 'Smith Family',
      isCustomer: true,
      isVendor: false,
      contactName: null,
      email: null,
      phone: null,
      address: null,
      shippingAddress: null,
      accountNumber: null,
      termsDays: 30,
      defaultAccountId: null,
      is1099: false,
      notes: null,
      active: true,
    });
    const invoice = session.createSalesDoc({
      kind: 'invoice',
      number: session.nextDocNumber('invoice'),
      customerId: customer,
      date: '2026-01-05',
      dueDate: null,
      termsDays: 30,
      memo: null,
      lines: [
        {
          itemId: null,
          description: 'Tuition',
          quantity: null,
          rate: null,
          amount: 950_00,
          incomeAccountId: id('Services'),
        },
      ],
    });

    const seen: string[] = [];
    const listen = (e: Event) =>
      seen.push(`${e.type}:${(e as CustomEvent<LedgerEventDetail>).detail.sourceType}`);
    ledgerEvents.addEventListener('posted', listen);
    ledgerEvents.addEventListener('voided', listen);
    try {
      const { paymentId } = await session.receivePayment({
        customerId: customer,
        date: '2026-01-20',
        depositAccountId: id('Checking'),
        method: 'Check',
        ref: '501',
        memo: null,
        applications: [{ docId: invoice, amount: 950_00 }],
      });
      expect(session.salesDoc(invoice)).toMatchObject({ state: 'paid', owed: 0 });
      await session.voidPayment(paymentId, null);
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
      ledgerEvents.removeEventListener('voided', listen);
    }
    expect(seen).toEqual(['posted:invoice_payment', 'voided:invoice_payment']);
    expect(session.salesDoc(invoice).owed).toBe(950_00);
    expect(session.status().dirty).toBe(true);
  });
});
