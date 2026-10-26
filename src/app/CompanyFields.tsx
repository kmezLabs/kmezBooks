// Company detail fields, shared by "New company" and the Company page (CO-1).

import type { CompanyDetails } from '../shared/company';
import { TextField } from './ui';

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function CompanyFields(props: {
  value: CompanyDetails;
  onChange: (changes: Partial<CompanyDetails>) => void;
}) {
  const v = props.value;
  const text = (key: keyof CompanyDetails) => String(v[key] ?? '');
  return (
    <>
      <div className="fields">
        <TextField
          label="Legal name"
          value={v.legalName}
          onChange={(legalName) => props.onChange({ legalName })}
          width="long"
        />
        <TextField
          label="EIN"
          value={text('ein')}
          onChange={(ein) => props.onChange({ ein })}
          placeholder="12-3456789"
          width="short"
        />
      </div>
      <div className="fields">
        <TextField
          label="Address"
          value={text('addressLine1')}
          onChange={(addressLine1) => props.onChange({ addressLine1 })}
          width="long"
        />
        <TextField
          label="Address line 2"
          value={text('addressLine2')}
          onChange={(addressLine2) => props.onChange({ addressLine2 })}
        />
      </div>
      <div className="fields">
        <TextField
          label="City"
          value={text('city')}
          onChange={(city) => props.onChange({ city })}
        />
        <TextField
          label="State"
          value={text('state')}
          onChange={(state) => props.onChange({ state })}
          placeholder="IL"
          width="short"
        />
        <TextField
          label="ZIP"
          value={text('postalCode')}
          onChange={(postalCode) => props.onChange({ postalCode })}
          width="short"
        />
        <label>
          Fiscal year starts
          <select
            value={v.fiscalYearStartMonth}
            onChange={(e) => props.onChange({ fiscalYearStartMonth: Number(e.target.value) })}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
