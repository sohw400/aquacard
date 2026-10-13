import type { CardState } from '../lib/types';
import './CardVisual.css';

interface CardVisualProps {
  card: CardState;
  revealed?: boolean;
  compact?: boolean;
}

export default function CardVisual({ card, revealed = false, compact = false }: CardVisualProps) {
  const issued = card.stage === 'issued' || card.stage === 'active';
  const plan = card.plan === 'plus' ? 'Plus' : 'Basic';
  const number = compact
    ? issued ? `•• ${card.last4}` : '•• ••••'
    : revealed && issued ? '4242 4242 4242 2048' : `••••  ••••  ••••  ${issued ? card.last4 : '••••'}`;

  return (
    <div
      className={`aqua-card-visual${card.plan === 'plus' ? ' acv-plus' : ''}${compact ? ' acv-compact' : ''}`}
      aria-label={`Aqua ${plan} 체험 카드${issued ? `, 끝 번호 ${card.last4}` : ', 디자인 미리보기'}`}
    >
      <div className="acv-top"><span className="acv-brand">aqua</span><span className="acv-plan">{plan.toUpperCase()}</span></div>
      <div className="acv-chip" aria-hidden="true"><span /><span /><span /></div>
      <div className="acv-number">{number}</div>
      <div className="acv-bottom"><span className="acv-holder">AQUA MEMBER</span><span className="acv-demo">체험 카드</span></div>
    </div>
  );
}
