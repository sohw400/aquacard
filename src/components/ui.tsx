import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { ChevronRight } from 'lucide-react';
import { liveRewards, reserveEarnings } from '../lib/engine';
import { won } from '../lib/format';
import type { AppState } from '../lib/types';

/** Large amounts set the unit smaller so the figure carries the weight. */
export function Won({ value, className = '', testId }: { value: number; className?: string; testId?: string }) {
  return <strong className={`won ${className}`} data-testid={testId}>{won(value)}<small>원</small></strong>;
}

/** Re-renders only the live figure, not the whole app. */
export function useTicker(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setInterval(() => setNow(Date.now()), reduce ? 1_000 : 100);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const fraction = (value: number) => (Math.floor(Math.min(Math.max(value, 0), 0.9999) * 10_000) / 10_000).toFixed(4).slice(1);

/** Whole won come from the ledger; only the fraction moves between engine ticks. */
export function LiveRewards({ state, testId }: { state: AppState; testId?: string }) {
  const now = useTicker();
  return <span className="live-figure"><strong data-testid={testId}>{won(state.rewards)}</strong><span className="live-fraction">{fraction(liveRewards(state, now) - state.rewards)}</span><small>원</small></span>;
}

export function LiveEarnings({ state, period, testId }: { state: AppState; period: 'today' | 'total'; testId?: string }) {
  const value = reserveEarnings(state, useTicker())[period];
  const whole = Math.floor(value + 1e-9);
  return <span className="live-figure small"><strong data-testid={testId}>+{won(whole)}</strong><span className="live-fraction">{fraction(value - whole)}</span><small>원</small></span>;
}

export function Toggle({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail?: string; testId?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong>{detail && <p>{detail}</p>}</div><button type="button" className={`switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}><span /></button></div>;
}

/** One tappable settings or summary line: label on the left, value and chevron on the right. */
export function NavRow({ label, detail, value, onClick, testId, danger = false }: { label: string; detail?: ReactNode; value?: ReactNode; onClick: () => void; testId?: string; danger?: boolean }) {
  return <button type="button" className={`nav-row${danger ? ' danger' : ''}`} data-testid={testId} onClick={onClick}>
    <span className="nav-row-main"><strong>{label}</strong>{detail && <span>{detail}</span>}</span>
    {value !== undefined && <span className="nav-row-value">{value}</span>}
    <ChevronRight className="nav-row-chevron" size={18} aria-hidden="true" />
  </button>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="section-title"><h2>{children}</h2>{action}</div>;
}

/** Digits with thousands commas; with decimals, one point and up to eight places. */
export function groupDigits(raw: string, decimals = false): string {
  const [whole, fraction] = raw.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals && fraction !== undefined ? `${grouped}.${fraction}` : grouped;
}

function cleanAmount(text: string, decimals: boolean): string {
  let digits = text.replace(decimals ? /[^\d.]/g : /\D/g, '');
  if (decimals) {
    const point = digits.indexOf('.');
    if (point >= 0) digits = `${digits.slice(0, point + 1)}${digits.slice(point + 1).replace(/\./g, '').slice(0, 8)}`;
    if (digits.startsWith('.')) digits = `0${digits}`;
  }
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * An amount field that groups digits with commas as you type. The input grows with the number and the unit
 * sits right after the last digit; the unit is also a label reaching to the end of the row, so a tap anywhere
 * on the row lands in the field. The value going in and out is the plain number text.
 */
export function AmountInput({ id, unit, value, onValueChange, decimals = false, ref, placeholder = '0', ...rest }: {
  id: string;
  unit: string;
  value: string;
  onValueChange: (value: string) => void;
  decimals?: boolean;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange' | 'type' | 'inputMode'>) {
  const own = useRef<HTMLInputElement | null>(null);
  const caret = useRef<number | null>(null);
  const shown = groupDigits(value, decimals);
  // Keep the caret after the same digit once commas are added or removed around it.
  useLayoutEffect(() => {
    const input = own.current;
    if (caret.current === null || !input || document.activeElement !== input) return;
    let seen = 0;
    let position = 0;
    while (position < shown.length && seen < caret.current) { if (/[\d.]/.test(shown[position])) seen += 1; position += 1; }
    input.setSelectionRange(position, position);
    caret.current = null;
  }, [shown]);
  return <span className="amount-sizer" data-value={shown || placeholder}>
    <input {...rest} id={id} ref={(element) => { own.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }}
      type="text" inputMode={decimals ? 'decimal' : 'numeric'} placeholder={placeholder} value={shown}
      onChange={(event) => {
        const text = event.target.value;
        const before = text.slice(0, event.target.selectionStart ?? text.length);
        caret.current = before.replace(decimals ? /[^\d.]/g : /\D/g, '').length;
        onValueChange(cleanAmount(text, decimals));
      }} />
    <label className="amount-unit" htmlFor={id}>{unit}</label>
  </span>;
}
