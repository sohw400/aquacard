import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { CardState } from '../lib/types';
import './CardVisual.css';

interface CardVisualProps {
  card: CardState;
  revealed?: boolean;
  compact?: boolean;
  variant?: 'standard' | 'hero';
}

export default function CardVisual({ card, revealed = false, compact = false, variant = 'standard' }: CardVisualProps) {
  const face = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const pose = useRef({ x: 0, y: 0 });
  const [motionAllowed, setMotionAllowed] = useState(false);
  const chipId = useId().replaceAll(':', '');
  const interactive = variant === 'hero' && !compact && !revealed;
  const issued = card.stage === 'issued' || card.stage === 'active';
  const plan = card.plan === 'plus' ? 'Plus' : 'Basic';
  const number = compact
    ? issued ? `•• ${card.last4}` : '•• ••••'
    : revealed && issued ? '4242 4242 4242 2048' : `••••  ••••  ••••  ${issued ? card.last4 : '••••'}`;

  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };

  const applyPose = (x: number, y: number) => {
    pose.current = { x, y };
    const style = face.current?.style;
    if (!style) return;
    style.setProperty('--acv-rx', `${(-y * 3.6).toFixed(2)}deg`);
    style.setProperty('--acv-ry', `${(x * 4.2).toFixed(2)}deg`);
    style.setProperty('--acv-light-x', `${50 + x * 30}%`);
    style.setProperty('--acv-light-y', `${45 + y * 28}%`);
    style.setProperty('--acv-light-opacity', x === 0 && y === 0 ? '0' : '.8');
  };

  const resetPose = () => {
    cancelFrame();
    applyPose(0, 0);
  };

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    const update = () => {
      setMotionAllowed(interactive && query.matches);
      if (!interactive || !query.matches) resetPose();
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
      cancelFrame();
    };
  }, [interactive]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || !motionAllowed || event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    pose.current = {
      x: clamp((event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2)),
      y: clamp((event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2)),
    };
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      applyPose(pose.current.x, pose.current.y);
    });
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !motionAllowed) return;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-.2, 0], ArrowRight: [.2, 0], ArrowUp: [0, -.2], ArrowDown: [0, .2] };
    if (event.key === 'Escape') {
      event.preventDefault();
      resetPose();
    } else if (event.key in directions) {
      event.preventDefault();
      cancelFrame();
      const [x, y] = directions[event.key];
      applyPose(Math.max(-1, Math.min(1, pose.current.x + x)), Math.max(-1, Math.min(1, pose.current.y + y)));
    }
  };

  return (
    <div
      ref={face}
      className={`aqua-card-visual${card.plan === 'plus' ? ' acv-plus' : ''}${compact ? ' acv-compact' : ''}${variant === 'hero' && !compact ? ' acv-hero' : ''}${motionAllowed && interactive ? ' acv-interactive' : ''}${revealed ? ' acv-revealed' : ''}`}
      role="img"
      aria-label={`Aqua ${plan} 체험 카드${issued ? `, 끝 번호 ${card.last4}` : ', 디자인 미리보기'}`}
      aria-description={interactive && motionAllowed ? '방향키로 카드 각도를 조절하고 Esc로 되돌릴 수 있습니다.' : undefined}
      aria-keyshortcuts={interactive && motionAllowed ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Escape' : undefined}
      tabIndex={interactive && motionAllowed ? 0 : undefined}
      onPointerMove={move}
      onPointerLeave={resetPose}
      onBlur={resetPose}
      onKeyDown={key}
    >
      <span className="acv-reflection" aria-hidden="true" />
      <svg className="acv-contour" viewBox="0 0 300 220" fill="none" aria-hidden="true"><path d="M11 237C12 135 191 157 222 67C238 22 241-22 301-37" /><path d="M42 250C37 157 217 176 245 86C261 38 263-2 315-17" /></svg>
      <div className="acv-top"><span className="acv-brand">aqua</span><span className="acv-plan">{plan.toUpperCase()}</span></div>
      <svg className="acv-chip" viewBox="0 0 42 32" aria-hidden="true">
        <defs><linearGradient id={`acv-metal-${chipId}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e8ece7" /><stop offset=".37" stopColor="#b5bfbe" /><stop offset=".62" stopColor="#dce1db" /><stop offset="1" stopColor="#a8b4b4" /></linearGradient></defs>
        <rect x=".5" y=".5" width="41" height="31" rx="5" fill={`url(#acv-metal-${chipId})`} stroke="#8e9da3" strokeWidth=".6" />
        <path d="M14 1V10H1M28 1V10H41M14 31V22H1M28 31V22H41M1 16H14M28 16H41" fill="none" stroke="#819298" strokeWidth=".65" />
        <rect x="14" y="10" width="14" height="12" rx="2" fill="none" stroke="#7d9096" strokeWidth=".65" />
        <path d="M2 2.5H12M30 2.5H39" stroke="#f4f6f0" strokeOpacity=".7" strokeWidth=".5" />
      </svg>
      <div className="acv-number">{number}</div>
      <div className="acv-bottom"><span className="acv-holder">AQUA MEMBER</span><span className="acv-demo">{issued ? '체험 카드' : compact ? '미리보기' : '디자인 미리보기'}</span></div>
    </div>
  );
}
