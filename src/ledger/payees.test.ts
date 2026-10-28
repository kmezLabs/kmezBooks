import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb, post } from '../../db/tests/ledgerTestDb';
import { createRule, listRules } from '../modules/banking/rules';
import type { Database } from '../worker/sqlite';
import { trialBalance } from './balances';
import {
  blankPayee,
  createPayee,
  defaultCategoryFor,
  deletePayee,
  getPayee,
  listPayees,
  mergePayee,
  payeeFor,
  payeeNames,
  updatePayee,
} from './payees';
import { postEntry, voidEntry } from './postEntry';

let db: Database;
beforeEach(async () => {
  db = await newLedgerDb();
});

const idOf = (name: string) =>
  String(db.selectValue('SELECT id FROM payee WHERE name = ?', [name]));
const namesOn = (entryId: number) =>
  db.selectObjects(
    `SELECT e.name, (SELECT group_concat(coalesce(l.name, '-')) FROM journal_line l WHERE l.entry_id = e.id) AS lines
     FROM journal_entry e WHERE e.id = ?`,
    [entryId],
  )[0];

describe('payees (GL-11)', () => {
  it('adds a payee on first use, and matches later names ignoring case and spaces', () => {
    const a = post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: ' City  Diner ' });
    const b = post(db, '2026-01-06', 'Meals', 'Checking', 12_00, { name: 'CITY DINER' });
    expect(payeeNames(db)).toEqual(['City Diner']);
    expect(namesOn(a)).toEqual({ name: 'City Diner', lines: '-,-' });
    expect(namesOn(b)).toEqual({ name: 'City Diner', lines: '-,-' });
    expect(payeeFor(db, '  ')).toBeNull();
    expect(listPayees(db)).toMatchObject([{ name: 'City Diner', uses: 2, lastUsed: '2026-01-06' }]);
  });

  it('keeps customer and vendor records, and lists them by kind', () => {
    const acme = createPayee(db, {
      ...blankPayee('Acme'),
      isVendor: true,
      email: 'ap@acme.example',
      termsDays: 30,
      defaultAccountId: accountId(db, 'Utilities'),
      is1099: true,
    });
    createPayee(db, { ...blankPayee('Tenant Co'), isCustomer: true });
    post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    expect(getPayee(db, acme)).toMatchObject({
      isVendor: true,
      isCustomer: false,
      termsDays: 30,
      is1099: true,
      uses: 0,
    });
    const names = (kind: Parameters<typeof listPayees>[1]) =>
      listPayees(db, kind).map((p) => p.name);
    expect(names({ kind: 'vendors' })).toEqual(['Acme']);
    expect(names({ kind: 'customers' })).toEqual(['Tenant Co']);
    expect(names({ kind: 'other' })).toEqual(['Diner']);
    expect(names({ search: 'acme.ex' })).toEqual(['Acme']);
    updatePayee(db, acme, { ...getPayee(db, acme), active: false });
    expect(names({})).toEqual(['Diner', 'Tenant Co']);
    expect(names({ includeInactive: true })).toEqual(['Acme', 'Diner', 'Tenant Co']);
  });

  it('refuses a second payee with the same name, bad terms or a bad email', () => {
    createPayee(db, blankPayee('Acme'));
    expect(() => createPayee(db, blankPayee('ACME'))).toThrow('already a payee named Acme');
    expect(() => createPayee(db, { ...blankPayee('B'), termsDays: 400 })).toThrow('Terms');
    expect(() => createPayee(db, { ...blankPayee('C'), email: 'nope' })).toThrow('email');
    expect(() => createPayee(db, blankPayee(' '))).toThrow('name');
  });

  it('renames a payee on every entry and line, void ones too, and in bank rules', () => {
    const a = post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    const b = postEntry(db, {
      date: '2026-01-06',
      name: 'Owner',
      sourceType: 'journal',
      lines: [
        { accountId: accountId(db, 'Meals'), debit: 5_00, credit: 0, name: 'Diner' },
        { accountId: accountId(db, 'Checking'), debit: 0, credit: 5_00 },
      ],
    });
    voidEntry(db, a, null);
    createRule(db, {
      name: 'Diner',
      active: true,
      accountId: null,
      direction: 'any',
      textContains: 'DINER',
      amountMin: null,
      amountMax: null,
      categoryId: accountId(db, 'Meals'),
      payee: 'diner',
      memo: null,
      autoPost: false,
    });
    const before = trialBalance(db, '2026-12-31').rows;
    const id = idOf('Diner');
    updatePayee(db, id, { ...getPayee(db, id), name: 'Corner Diner' });
    expect(namesOn(a)).toEqual({ name: 'Corner Diner', lines: '-,-' });
    expect(namesOn(b)).toEqual({ name: 'Owner', lines: 'Corner Diner,-' });
    expect(listRules(db)[0]!.payee).toBe('Corner Diner');
    expect(trialBalance(db, '2026-12-31').rows).toEqual(before);
    // The old name is a new payee again if someone types it
    expect(payeeFor(db, 'Diner')!.id).not.toBe(id);
  });

  it('merges one payee into another: entries, lines and rules move, details fill in', () => {
    const into = createPayee(db, {
      ...blankPayee('Home Depot'),
      isVendor: true,
      phone: '555-0100',
    });
    const from = createPayee(db, {
      ...blankPayee('THE HOME DEPOT #0149'),
      isCustomer: true,
      email: 'store@hd.example',
      phone: '555-0199',
    });
    const a = post(db, '2026-01-05', 'Repairs and Maintenance', 'Checking', 85_05, {
      name: 'the home depot #0149',
    });
    const b = post(db, '2026-01-09', 'Repairs and Maintenance', 'Checking', 12_00, {
      name: 'Home Depot',
    });
    voidEntry(db, b, null);
    mergePayee(db, from, into);
    expect(namesOn(a)).toEqual({ name: 'Home Depot', lines: '-,-' });
    expect(getPayee(db, into)).toMatchObject({
      name: 'Home Depot',
      isVendor: true,
      isCustomer: true,
      phone: '555-0100',
      email: 'store@hd.example',
      uses: 1,
    });
    expect(() => getPayee(db, from)).toThrow('no longer exists');
    expect(() => mergePayee(db, into, into)).toThrow('another payee');
    expect(Number(db.selectValue(`SELECT count(*) FROM audit_event WHERE action = 'payee'`))).toBe(
      1,
    );
  });

  it('gives a vendor’s default category for a typed name, while that account is active (AP-1)', () => {
    const utilities = accountId(db, 'Utilities');
    createPayee(db, { ...blankPayee('Power Co'), isVendor: true, defaultAccountId: utilities });
    createPayee(db, blankPayee('Diner'));
    expect(defaultCategoryFor(db, ' power  co ')).toBe(utilities);
    expect(defaultCategoryFor(db, 'Diner')).toBeNull();
    expect(defaultCategoryFor(db, 'Nobody')).toBeNull();
    db.exec({ sql: 'UPDATE account SET active = 0 WHERE id = ?', bind: [utilities] });
    expect(defaultCategoryFor(db, 'Power Co')).toBeNull();
  });

  it('deletes only an unused payee', () => {
    post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    const unused = createPayee(db, blankPayee('Unused'));
    expect(() => deletePayee(db, idOf('Diner'))).toThrow('merge it into another payee');
    deletePayee(db, unused);
    expect(payeeNames(db)).toEqual(['Diner']);
  });
});
