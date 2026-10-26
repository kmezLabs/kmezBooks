// Create a company in a new folder (CO-1, DF-1).

import { useState } from 'react';
import { normalizeDetails, validateDetails, type NewCompany } from '../shared/company';
import { db } from '../shared/workerClient';
import { afterOpen } from './afterOpen';
import { pickFolder } from './recentFolders';
import { deviceName } from './settings';
import { Dialog, ErrorText, TextField, passphraseProblem, useAction } from './ui';
import { CompanyFields, MONTHS } from './CompanyFields';

const EMPTY: NewCompany = {
  legalName: '',
  ein: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  fiscalYearStartMonth: 1,
  ownerName: '',
};

export function CreateCompanyDialog({ onClose }: { onClose: () => void }) {
  const [details, setDetails] = useState<NewCompany>(EMPTY);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, setError, run } = useAction();

  const create = () => {
    const d = normalizeDetails(details);
    const problems = validateDetails(d);
    if (!d.ownerName.trim()) problems.push("Enter the owner's name.");
    const pass = passphraseProblem(passphrase, confirm);
    if (pass) problems.push(pass);
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    void run(async () => {
      const dir = await pickFolder();
      if (!dir) return;
      const { status } = await db.create(dir, d, passphrase, deviceName());
      await afterOpen(dir, status);
    });
  };

  return (
    <Dialog title="New company" onClose={busy ? undefined : onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <CompanyFields value={details} onChange={(d) => setDetails({ ...details, ...d })} />
        <div className="fields">
          <TextField
            label="Your name (owner)"
            value={details.ownerName}
            onChange={(ownerName) => setDetails({ ...details, ownerName })}
          />
        </div>
        <h3>Passphrase</h3>
        <p className="muted">
          The company's books are encrypted with this passphrase. It cannot be recovered: if it is
          lost, so are the books, except for backups whose passphrase you know.
        </p>
        <div className="fields">
          <TextField
            label="Passphrase"
            type="password"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="new-password"
          />
          <TextField
            label="Repeat it"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
        </div>
        <p className="muted">
          Next, choose an empty folder for this company, for example{' '}
          <code>Documents\EasyBooks\{details.legalName.trim() || 'Company name'}</code>. Fiscal year
          starts in {MONTHS[details.fiscalYearStartMonth - 1]}.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Choose folder and create'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
