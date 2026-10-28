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

  it('makes the invoice PDF with the logo, and what the email says (AR-4, AR-8)', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'pw', 'PC');
    session.updateDetails({ email: 'office@acme.example', invoiceFooter: 'Pay by Zelle.' });
    // A 1×1 PNG
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    session.setCompanyLogo(png);
    expect(session.companyLogo()).toEqual(png);
    expect(() => session.setCompanyLogo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(
      /CHECK/,
    );

    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const customer = session.createPayee({
      name: 'Smith Family',
      isCustomer: true,
      isVendor: false,
      contactName: null,
      email: 'smiths@example.com',
      phone: null,
      address: '12 Oak Lane',
      shippingAddress: null,
      accountNumber: null,
      termsDays: 15,
      defaultAccountId: null,
      is1099: false,
      notes: null,
      active: true,
    });
    const invoice = session.createSalesDoc({
      kind: 'invoice',
      number: '1001',
      customerId: customer,
      date: '2026-01-05',
      dueDate: null,
      termsDays: 15,
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
    const pdf = await session.docPdf(invoice);
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pdf).toMatchObject({
      fileName: 'Invoice 1001 - Smith Family.pdf',
      email: 'smiths@example.com',
      subject: 'Invoice 1001 from Acme LLC',
    });
    expect(pdf.body).toContain('invoice 1001 for 950.00, due Jan 20, 2026');
    session.markDocSent(invoice);
    expect(session.salesDoc(invoice).status).toBe('sent');
    session.setCompanyLogo(null);
    expect(session.companyLogo()).toBeNull();
  });
});
