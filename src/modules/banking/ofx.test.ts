import { describe, expect, it } from 'vitest';
import { decodeOfx, feedKey, feedLabel, ofxAmount, ofxDate, parseOfx } from './ofx';
import { ofxXmlFile, qboFile } from './testing/ofxFixtures';

const enc = (s: string) => new TextEncoder().encode(s);

describe('.qbo statements (BK-1)', () => {
  it('reads a bank statement in OFX 1.x (SGML)', () => {
    const [s, ...rest] = parseOfx(
      qboFile({
        account: '000123456789',
        balance: '1523.40',
        balanceDate: '2026-01-31',
        txns: [
          {
            fitid: 'A1',
            date: '2026-01-03',
            amount: '2500.00',
            name: 'ACME PAYROLL',
            memo: 'Direct dep',
          },
          { fitid: 'A2', date: '2026-01-05', amount: '-45.10', name: 'CITY POWER &amp; LIGHT' },
          { fitid: 'A3', date: '2026-01-09', amount: '-900', type: 'CHECK', checkNo: '1042' },
        ],
      }),
    );
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({
      kind: 'bank',
      bankId: '111000025',
      accountNumber: '000123456789',
      accountType: 'CHECKING',
      currency: 'USD',
      startDate: '2026-01-03',
      endDate: '2026-01-09',
      balance: 1_523_40,
      balanceDate: '2026-01-31',
    });
    expect(s!.transactions).toEqual([
      {
        fitid: 'A1',
        date: '2026-01-03',
        amount: 2_500_00,
        type: 'CREDIT',
        name: 'ACME PAYROLL',
        memo: 'Direct dep',
        checkNo: null,
      },
      {
        fitid: 'A2',
        date: '2026-01-05',
        amount: -45_10,
        type: 'DEBIT',
        name: 'CITY POWER & LIGHT',
        memo: null,
        checkNo: null,
      },
      {
        fitid: 'A3',
        date: '2026-01-09',
        amount: -900_00,
        type: 'CHECK',
        name: null,
        memo: null,
        checkNo: '1042',
      },
    ]);
    expect(feedKey(s!)).toBe('bank:111000025:000123456789');
    expect(feedLabel(s!)).toBe('Checking ••6789');
  });

  it('reads a credit card statement in OFX 2.x (XML), charges negative', () => {
    const [s] = parseOfx(
      ofxXmlFile({
        kind: 'card',
        account: '4111222233334444',
        balance: '-312.55',
        txns: [
          { fitid: 'C1', date: '2026-02-02', amount: '-12.55', name: 'COFFEE <&> CO' },
          { fitid: 'C2', date: '2026-02-10', amount: '+300.00', name: 'PAYMENT THANK YOU' },
        ],
      }),
    );
    expect(s).toMatchObject({
      kind: 'card',
      bankId: null,
      accountNumber: '4111222233334444',
      balance: -312_55,
    });
    expect(s!.transactions.map((t) => [t.name, t.amount])).toEqual([
      ['COFFEE <&> CO', -12_55],
      ['PAYMENT THANK YOU', 300_00],
    ]);
    expect(feedKey(s!)).toBe('card:4111222233334444');
    expect(feedLabel(s!)).toBe('Credit card ••4444');
  });

  it('reads several statements from one file, and leaves out zero amounts', () => {
    const statements = parseOfx(
      qboFile(
        {
          account: '111',
          txns: [
            { date: '2026-01-02', amount: '10.00' },
            { date: '2026-01-03', amount: '0.00' },
          ],
        },
        { account: '222', accountType: 'SAVINGS', txns: [{ date: '2026-01-02', amount: '-1.00' }] },
        { kind: 'card', account: '9999', txns: [] },
      ),
    );
    expect(statements.map((s) => [feedLabel(s), s.transactions.length])).toEqual([
      ['Checking ••111', 1],
      ['Savings ••222', 1],
      ['Credit card ••9999', 0],
    ]);
  });

  it('takes the payee from a PAYEE aggregate when there is no NAME', () => {
    const file = qboFile({ txns: [{ fitid: 'P1', date: '2026-03-01', amount: '-5.00' }] }).replace(
      '<FITID>P1',
      '<FITID>P1\n<PAYEE>\n<NAME>Corner Store\n<CITY>Springfield\n</PAYEE>',
    );
    expect(parseOfx(file)[0]!.transactions[0]!.name).toBe('Corner Store');
  });

  it('refuses files that are not statements, with the bank’s message when it sent one', () => {
    expect(() => parseOfx('Date,Amount\n2026-01-01,5')).toThrow(/not a bank statement file/);
    const refused = `OFXHEADER:100\n\n<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Session expired</STATUS></SONRS></SIGNONMSGSRSV1></OFX>`;
    expect(() => parseOfx(refused)).toThrow('The bank says: Session expired');
  });

  it('refuses a transaction with an unreadable amount or date', () => {
    const bad = qboFile({ account: '5555', txns: [{ date: '2026-01-02', amount: '12.345' }] });
    expect(() => parseOfx(bad)).toThrow('Account ending 5555: the amount "12.345" is not valid.');
    const noDate = qboFile({ txns: [{ date: '2026-01-02', amount: '1.00' }] }).replace(
      /<DTPOSTED>\S+/,
      '<DTPOSTED>2026',
    );
    expect(() => parseOfx(noDate)).toThrow(/no valid date/);
  });

  it('parses amounts exactly from their digits', () => {
    expect(ofxAmount('-1234.56')).toBe(-1_234_56);
    expect(ofxAmount('+5')).toBe(5_00);
    expect(ofxAmount('12.3400')).toBe(12_34);
    expect(ofxAmount('-1234,56')).toBe(-1_234_56);
    expect(ofxAmount('.5')).toBe(50);
    expect(ofxAmount('-0.00')).toBe(0);
    expect(ofxAmount('0.1 + 0.2')).toBeNull();
    expect(ofxAmount('1.005')).toBeNull();
    expect(ofxAmount('')).toBeNull();
    expect(ofxAmount('99999999999999999999')).toBeNull();
  });

  it('reads the date part of OFX date-times', () => {
    expect(ofxDate('20260131')).toBe('2026-01-31');
    expect(ofxDate('20260131235959.000[-5:EST]')).toBe('2026-01-31');
    expect(ofxDate('20260231')).toBeNull();
    expect(ofxDate(null)).toBeNull();
  });

  it('decodes the file with the character set it declares', () => {
    // "Café" in Windows-1252: é is 0xE9
    const sgml = qboFile({ txns: [{ date: '2026-01-02', amount: '-4.50', name: 'CAF#' }] });
    const bytes = enc(sgml);
    bytes[sgml.indexOf('CAF#') + 3] = 0xe9;
    expect(parseOfx(decodeOfx(bytes))[0]!.transactions[0]!.name).toBe('CAFé');
    const xml = ofxXmlFile({ txns: [{ date: '2026-01-02', amount: '-4.50', name: 'Café' }] });
    expect(parseOfx(decodeOfx(enc(xml)))[0]!.transactions[0]!.name).toBe('Café');
  });
});
