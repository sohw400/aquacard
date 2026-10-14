import { useEffect, useRef, useState } from 'react';
import heroCards from '../assets/aqua-cards.webp';
import './CardHero.css';

/**
 * The two-card hero. The still image shows at once; the same scene then loads and renders live, so touching the
 * cards tilts them and the light moves across their faces. Without WebGL or with reduced motion the image stays.
 */
export default function CardHero({ className, alt = '' }: { className?: string; alt?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    import('../lib/cardScene').then(({ mountCardScene }) => {
      if (cancelled || !host.current) return;
      cleanup = mountCardScene(host.current, () => setLive(true), () => setLive(false));
    }).catch(() => { /* No WebGL: keep the still image. */ });
    return () => { cancelled = true; cleanup?.(); setLive(false); };
  }, []);

  return <div ref={host} className={`card-hero${live ? ' live' : ''}${className ? ` ${className}` : ''}`}>
    <img src={heroCards} width={960} height={630} alt={alt} draggable={false} />
  </div>;
}
