import { useId } from 'react';

/** Geometric lowercase wordmark: circles and stems share one stroke so it stays crisp at any size. */
export function Wordmark({ height = 24, className = '' }: { height?: number; className?: string }) {
  return <svg className={`aqua-wordmark ${className}`} height={height} width={height * 101 / 32} viewBox="-0.5 5.5 101 32" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" strokeWidth="4.6">
      <circle cx="11" cy="18" r="8.7" /><path d="M19.7 7v22" />
      <circle cx="37" cy="18" r="8.7" /><path d="M45.7 7v30" />
      <path d="M54.3 7v11a8.7 8.7 0 0 0 17.4 0V7" /><path d="M71.7 7v22" />
      <circle cx="89" cy="18" r="8.7" /><path d="M97.7 7v22" />
    </g>
  </svg>;
}

/** The mark: a coin-shaped circle with a single swell of water. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const clip = `${useId()}-clip`;
  return <svg className={`aqua-mark ${className}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <clipPath id={clip}><circle cx="16" cy="16" r="16" /></clipPath>
    <g clipPath={`url(#${clip})`}>
      <rect width="32" height="32" fill="currentColor" />
      <path className="aqua-mark-water" d="M-1 17.2C5 12.6 10.6 12.6 16 16.6s11 4.4 17-.2V33H-1z" />
    </g>
  </svg>;
}

export default function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <span className={`aqua-logo ${className}`} role="img" aria-label="aqua">
    <LogoMark size={size} />
    <Wordmark height={size * 0.92} />
  </span>;
}
