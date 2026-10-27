// Made-up statement files in the shapes banks send: OFX 1.x SGML with the
// Intuit .qbo header, and OFX 2.x XML. No real bank data.

export interface FixtureTxn {
  fitid?: string | null;
  date: string; // YYYY-MM-DD
  amount: string; // as the file writes it: "-12.34"
  type?: string;
  name?: string;
  memo?: string;
  checkNo?: string;
}

export interface FixtureStatement {
  kind?: 'bank' | 'card';
  bankId?: string;
  account?: string;
  accountType?: string;
  start?: string;
  end?: string;
  balance?: string;
  balanceDate?: string;
  txns: FixtureTxn[];
}

const ofxDate = (iso: string) => `${iso.replaceAll('-', '')}120000.000[-5:EST]`;

function sgmlTxn(t: FixtureTxn): string {
  return [
    '<STMTTRN>',
    `<TRNTYPE>${t.type ?? (t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT')}`,
    `<DTPOSTED>${ofxDate(t.date)}`,
    `<TRNAMT>${t.amount}`,
    t.fitid === null ? '' : `<FITID>${t.fitid ?? `${t.date}-${t.amount}`}`,
    t.checkNo ? `<CHECKNUM>${t.checkNo}` : '',
    t.name ? `<NAME>${t.name}` : '',
    t.memo ? `<MEMO>${t.memo}` : '',
    '</STMTTRN>',
  ]
    .filter(Boolean)
    .join('\n');
}

function sgmlStatement(s: FixtureStatement): string {
  const card = s.kind === 'card';
  const account = s.account ?? (card ? '4111222233334444' : '1234567890');
  const from = card
    ? `<CCACCTFROM>\n<ACCTID>${account}\n</CCACCTFROM>`
    : `<BANKACCTFROM>\n<BANKID>${s.bankId ?? '111000025'}\n<ACCTID>${account}\n<ACCTTYPE>${s.accountType ?? 'CHECKING'}\n</BANKACCTFROM>`;
  const tag = card ? 'CCSTMTRS' : 'STMTRS';
  const wrap = card ? 'CCSTMTTRNRS' : 'STMTTRNRS';
  const dates = s.txns.map((t) => t.date).sort();
  return `<${wrap}>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<${tag}>
<CURDEF>USD
${from}
<BANKTRANLIST>
<DTSTART>${ofxDate(s.start ?? dates[0] ?? '2026-01-01')}
<DTEND>${ofxDate(s.end ?? dates.at(-1) ?? '2026-01-31')}
${s.txns.map(sgmlTxn).join('\n')}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${s.balance ?? '0.00'}
<DTASOF>${ofxDate(s.balanceDate ?? s.end ?? dates.at(-1) ?? '2026-01-31')}
</LEDGERBAL>
</${tag}>
</${wrap}>`;
}

/** A .qbo file as most banks send it: OFX 1.x SGML with the Intuit header. */
export function qboFile(...statements: FixtureStatement[]): string {
  const bank = statements.filter((s) => s.kind !== 'card');
  const card = statements.filter((s) => s.kind === 'card');
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260131120000.000
<LANGUAGE>ENG
<INTU.BID>3000
</SONRS>
</SIGNONMSGSRSV1>
${bank.length ? `<BANKMSGSRSV1>\n${bank.map(sgmlStatement).join('\n')}\n</BANKMSGSRSV1>` : ''}
${card.length ? `<CREDITCARDMSGSRSV1>\n${card.map(sgmlStatement).join('\n')}\n</CREDITCARDMSGSRSV1>` : ''}
</OFX>
`;
}

const xmlText = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

/** The same statement as OFX 2.x XML. */
export function ofxXmlFile(s: FixtureStatement): string {
  const sgml = sgmlStatement(s);
  // Close every value element, as XML requires
  const xml = sgml
    .split('\n')
    .map((line) => {
      const m = /^<([A-Z0-9.]+)>(.+)$/.exec(line);
      return m ? `<${m[1]}>${xmlText(m[2]!)}</${m[1]}>` : line;
    })
    .join('\n');
  const msgs = s.kind === 'card' ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1';
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20260131</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>
<${msgs}>
${xml}
</${msgs}>
</OFX>
`;
}
