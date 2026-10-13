import { useEffect, useState, type ReactNode } from 'react';
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
