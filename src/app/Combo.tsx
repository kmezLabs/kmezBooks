// A text field with a list that narrows as you type, to what starts with the
// typed text (not what merely contains it). Used for accounts (categories)
// and payees. Arrow keys move through the list; Enter or Tab picks; Escape
// closes it and puts the field back.

import { useEffect, useId, useRef, useState } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  /** A heading the option is listed under, e.g. the account type */
  group?: string;
  /** Texts whose beginning is matched against what's typed */
  keys: string[];
}

/** At most this many options are listed; typing narrows the rest */
const SHOWN = 100;

export function Combo(props: {
  options: ComboOption[];
  /** The chosen option's value; with freeText, the text itself */
  value: string;
  onChange: (value: string) => void;
  /** Any text is a value (a payee name); otherwise only an option is */
  freeText?: boolean;
  placeholder?: string;
  /** An option for "none", with the value '' */
  emptyLabel?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // What's been typed since the field got focus; null: nothing yet, so the whole list shows
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = props.options.find((o) => o.value === props.value);
  const shown = props.freeText ? props.value : (selected?.label ?? '');
  const q = (query ?? '').trim().toLowerCase();
  const matches = q
    ? props.options.filter((o) => o.keys.some((k) => k.toLowerCase().startsWith(q)))
    : [
        ...(props.emptyLabel ? [{ value: '', label: props.emptyLabel, keys: [] }] : []),
        ...props.options,
      ];
  const items = matches.slice(0, SHOWN);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: ComboOption | undefined) => {
    if (o) props.onChange(o.value);
    setQuery(null);
    setOpen(false);
  };

  return (
    <div className="combo">
      <input
        ref={input}
        role="combobox"
        aria-label={props.ariaLabel}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={props.autoFocus}
        placeholder={props.placeholder ?? (props.freeText ? undefined : props.emptyLabel)}
        value={query ?? shown}
        onFocus={(e) => {
          e.target.select();
          setQuery(null);
          setActive(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          if (props.freeText) props.onChange(e.target.value);
        }}
        onBlur={() => {
          setOpen(false);
          if (query !== null && !props.freeText) {
            const typed = query.trim().toLowerCase();
            const exact = props.options.find((o) => o.label.toLowerCase() === typed);
            if (exact) props.onChange(exact.value);
            else if (!typed && props.emptyLabel !== undefined) props.onChange('');
          }
          setQuery(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) setOpen(true);
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => Math.min(Math.max(a + step, 0), Math.max(items.length - 1, 0)));
          } else if (e.key === 'Enter' && open && items[active]) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === 'Tab' && open && query !== null && q && items[active]) {
            pick(items[active]);
          } else if (e.key === 'Escape' && open) {
            // Close the list, not the dialog around it
            e.preventDefault();
            e.stopPropagation();
            setQuery(null);
            setOpen(false);
          }
        }}
      />
      {open && items.length > 0 && (
        <ul ref={list} id={`${id}-list`} role="listbox" className="combo-list">
          {items.map((o, i) => (
            <ComboItem
              key={o.value || '(none)'}
              id={`${id}-${i}`}
              option={o}
              heading={o.group !== undefined && o.group !== items[i - 1]?.group ? o.group : null}
              active={i === active}
              chosen={o.value === props.value}
              onPick={() => pick(o)}
            />
          ))}
          {matches.length > SHOWN && (
            <li className="combo-more" role="presentation">
              {matches.length - SHOWN} more: keep typing
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ComboItem(props: {
  id: string;
  option: ComboOption;
  heading: string | null;
  active: boolean;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <>
      {props.heading && (
        <li className="combo-group" role="presentation">
          {props.heading}
        </li>
      )}
      <li
        id={props.id}
        role="option"
        aria-selected={props.active}
        className={[props.active && 'active', props.chosen && 'chosen'].filter(Boolean).join(' ')}
        // Before the field loses focus
        onMouseDown={(e) => {
          e.preventDefault();
          props.onPick();
        }}
      >
        {props.option.label}
      </li>
    </>
  );
}
