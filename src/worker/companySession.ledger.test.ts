import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { ATTACHMENT_DIR } from './attachments';
import { BACKUP_DIR } from './backups';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

async function openCompany() {
  const dir = new FakeDir();
  const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
  await session.create(asDir(dir), ACME, 'the passphrase', 'PC');
  const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
  const entry = (date: string, cents = 25_00) => ({
    date,
    memo: 'Test',
    lines: [
      { accountId: id('Meals'), debit: cents, credit: 0 },
      { accountId: id('Checking'), debit: 0, credit: cents },
    ],
  });
  return { dir, session, id, entry };
}

describe('session: ledger (GL-2, GL-4, PC-1, PC-2)', () => {
  it('starts new companies with the standard chart, or empty if asked', async () => {
    const { session } = await openCompany();
    expect(session.accounts().length).toBeGreaterThan(30);
    const empty = new CompanySession({ iterations: 1_000, heartbeatMs: 0 });
    await empty.create(asDir(new FakeDir()), { ...ACME, standardChart: false }, 'pw', 'PC');
    expect(empty.accounts()).toEqual([]);
    expect(empty.seedChart()).toBeGreaterThan(30);
  });

  it('posts and voids through the session, announcing both (rule 8)', async () => {
    const { session, entry } = await openCompany();
    const seen: string[] = [];
    const listen = (e: Event) =>
      seen.push(`${e.type}:${(e as CustomEvent<LedgerEventDetail>).detail.sourceType}`);
    ledgerEvents.addEventListener('posted', listen);
    ledgerEvents.addEventListener('voided', listen);
    try {
      const id = await session.postJournalEntry(entry('2026-03-01'));
      expect(session.status().dirty).toBe(true);
      expect(session.entry(id)).toMatchObject({ status: 'posted', amount: 25_00, files: [] });
      await session.voidEntry(id, 'duplicate');
      expect(session.entry(id)).toMatchObject({ status: 'void', voidReason: 'duplicate' });
      expect(seen).toEqual(['posted:journal', 'voided:journal']);
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
      ledgerEvents.removeEventListener('voided', listen);
    }
  });

  it('needs the passphrase again to change a closed period (PC-2)', async () => {
    const { session, entry } = await openCompany();
    session.setClosingDate('2025-12-31');
    expect(session.closingDate()).toBe('2025-12-31');
    await expect(session.postJournalEntry(entry('2025-12-15'))).rejects.toMatchObject({
      name: 'ClosedPeriodError',
    });
    await expect(session.postJournalEntry(entry('2025-12-15'), 'wrong')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
    const id = await session.postJournalEntry(entry('2025-12-15'), 'the passphrase');
    expect(
      session
        .audit({ limit: 50 })
        .some((e) => e.action === 'closed_period_override' && e.entityId === String(id)),
    ).toBe(true);
    expect(() => session.setClosingDate('2025-13-01')).toThrow(/valid date/);
    session.setClosingDate(null);
    expect(session.closingDate()).toBeNull();
  });

  it('lists entries newest first, filters, and pages', async () => {
    const { session, entry } = await openCompany();
    for (const d of ['2026-01-05', '2026-01-07', '2026-01-06']) {
      await session.postJournalEntry({ ...entry(d), ref: d.slice(-2) });
    }
    const all = session.entries();
    expect(all.map((e) => e.date)).toEqual(['2026-01-07', '2026-01-06', '2026-01-05']);
    expect(session.entries({ limit: 1, after: all[0] }).map((e) => e.date)).toEqual(['2026-01-06']);
    expect(session.entries({ search: '05' }).map((e) => e.date)).toEqual(['2026-01-05']);
  });

  it('stores attachments encrypted, with a copy beside the backups, and opens them back', async () => {
    const { dir, session, entry } = await openCompany();
    const id = await session.postJournalEntry(entry('2026-03-01'));
    const receipt = new File([new TextEncoder().encode('receipt: lunch $25.00')], 'lunch.txt', {
      type: 'text/plain',
    });
    const row = await session.addAttachment('journal_entry', String(id), receipt);
    expect(row).toMatchObject({ fileName: 'lunch.txt', mimeType: 'text/plain', size: 21 });

    const stored = dir.dirs.get(ATTACHMENT_DIR)!.files.get(`${row.id}.kma`)!.data;
    expect(Buffer.from(stored).includes(Buffer.from('receipt'))).toBe(false);
    expect(dir.dirs.get(BACKUP_DIR)!.dirs.get(ATTACHMENT_DIR)!.files.has(`${row.id}.kma`)).toBe(
      true,
    );

    const opened = await session.openAttachment(row.id);
    expect(new TextDecoder().decode(opened.bytes)).toBe('receipt: lunch $25.00');
    expect(session.entry(id)!.files).toHaveLength(1);
    expect(session.entries()[0]!.attachments).toBe(1);

    session.removeAttachment(row.id);
    expect(session.entry(id)!.files).toEqual([]);
    // The encrypted file stays, for older backups that still list it
    expect(dir.dirs.get(ATTACHMENT_DIR)!.files.has(`${row.id}.kma`)).toBe(true);
  });

  it('opens an attachment saved as <id>.eba, from before the rename from EasyBooks', async () => {
    const { dir, session, entry } = await openCompany();
    const id = await session.postJournalEntry(entry('2026-03-01'));
    const row = await session.addAttachment(
      'journal_entry',
      String(id),
      new File(['old'], 'a.txt'),
    );
    const files = dir.dirs.get(ATTACHMENT_DIR)!.files;
    files.set(`${row.id}.eba`, files.get(`${row.id}.kma`)!);
    files.delete(`${row.id}.kma`);
    expect(new TextDecoder().decode((await session.openAttachment(row.id)).bytes)).toBe('old');
  });

  it('reports a missing or swapped attachment file', async () => {
    const { dir, session, entry } = await openCompany();
    const id = await session.postJournalEntry(entry('2026-03-01'));
    const a = await session.addAttachment('journal_entry', String(id), new File(['one'], 'a.txt'));
    const b = await session.addAttachment('journal_entry', String(id), new File(['two'], 'b.txt'));
    const files = dir.dirs.get(ATTACHMENT_DIR)!.files;
    files.set(`${a.id}.kma`, files.get(`${b.id}.kma`)!);
    await expect(session.openAttachment(a.id)).rejects.toMatchObject({
      name: 'AttachmentMissingError',
    });
    files.delete(`${b.id}.kma`);
    await expect(session.openAttachment(b.id)).rejects.toThrow(/missing/);
  });

  it('refuses attachments for entries that do not exist', async () => {
    const { session } = await openCompany();
    await expect(
      session.addAttachment('journal_entry', '999', new File(['x'], 'x.txt')),
    ).rejects.toThrow(/does not exist/);
  });
});
