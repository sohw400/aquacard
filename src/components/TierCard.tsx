import standard from '../assets/tier-standard.webp';
import premium from '../assets/tier-premium.webp';
import gold from '../assets/tier-private.webp';
import type { Plan } from '../lib/types';

const IMAGES: Record<Plan, string> = { standard, premium, private: gold };

/** Rendered card for each membership; small enough for lists, detailed enough to tell the tiers apart. */
export default function TierCard({ plan, className = '' }: { plan: Plan; className?: string }) {
  return <img className={`tier-card${className ? ` ${className}` : ''}`} src={IMAGES[plan]} width={264} height={178} alt="" draggable={false} />;
}
