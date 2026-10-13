import { ChevronRight, Clock3, LockKeyhole } from 'lucide-react';
import TierCard from '../components/TierCard';
import { ActivityList } from '../components/Activity';
import { LiveRewards, Won } from '../components/ui';
import { availableToSpend, reserveTerms } from '../lib/engine';
import { money, percent } from '../lib/format';
import { fundingStatusLabel, getHeldFundingWon, isFundingPending } from '../lib/movements';
import { fundingLabel, PLANS } from '../lib/policy';
import type { AppState, Payment } from '../lib/types';
import heroCards from '../assets/aqua-cards.webp';

interface HomeProps {
  state: AppState;
  onDeposit: () => void;
  onSend: () => void;
  onCard: () => void;
  onPay: () => void;
  onReserve: () => void;
  onRewards: () => void;
  onActivity: () => void;
  onFunding: (id: string) => void;
  onRefund: (payment: Payment) => void;
}

const PREPARING = ['submitted', 'approved', 'issued'];

/** Balance first, then the card, what is growing, and what happened lately. */
export default function Home({ state, onDeposit, onSend, onCard, onPay, onReserve, onRewards, onActivity, onFunding, onRefund }: HomeProps) {
  const { card } = state;
  const plan = PLANS[card.plan];
  const pending = state.fundingOperations.filter(isFundingPending);
  const held = getHeldFundingWon(state);
  const active = card.stage === 'active';
  const cardLine = active ? card.locked ? '잠겨 있어요' : `끝번호 ${card.last4}`
    : PREPARING.includes(card.stage) ? '만드는 중이에요'
      : card.stage === 'needs_info' ? '확인할 내용이 있어요'
        : card.stage === 'rejected' ? '승인되지 않았어요' : '신청을 이어서 할 수 있어요';

  return <div className="page home-page">
    <section className="home-balance" aria-labelledby="home-balance-label">
      <span className="eyebrow" id="home-balance-label">잔액</span>
      <Won value={state.spend} className="balance-figure" testId="spend-balance" />
      {held > 0 && <p className="balance-note">보내는 중 <strong data-testid="funding-held">{money(held)}</strong></p>}
      <div className="home-actions">
        <button type="button" className="btn primary" data-testid="open-deposit" onClick={onDeposit}>충전</button>
        <button type="button" className="btn neutral" data-testid="open-send" onClick={onSend}>보내기</button>
      </div>
      {pending[0] && <button type="button" className="home-status" data-testid="home-funding-status" onClick={() => pending.length > 1 ? onActivity() : onFunding(pending[0].id)}>
        <Clock3 size={16} aria-hidden="true" />
        <span>{pending.length > 1 ? `처리 중인 입출금 ${pending.length}건` : `${fundingLabel(pending[0].symbol)} ${pending[0].kind === 'deposit' ? '입금' : '출금'} · ${fundingStatusLabel(pending[0].status)}`}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>}
    </section>

    {card.stage === 'not_applied' ? <section className="home-card-offer" aria-label="Aqua 카드">
      <img src={heroCards} width={960} height={630} alt="" />
      <div>
        <h2>카드를 만들면 잔액으로 바로 결제해요</h2>
        <p>가상카드는 무료이고 신청하면 바로 나와요. 결제할 때마다 {percent(PLANS.standard.cashbackRate)}를 돌려받아요.</p>
      </div>
      <button type="button" className="btn primary block" data-testid="open-payment" onClick={onPay}>카드 만들기</button>
    </section> : <section className="home-card" aria-label="내 카드">
      <button type="button" className="home-card-main" data-testid="card-cta" onClick={onCard}>
        <TierCard plan={card.plan} className="home-card-thumb" />
        <span className="home-card-copy"><strong>{plan.name}</strong><span className={card.locked && active ? 'warning' : ''}>{card.locked && active && <LockKeyhole size={13} aria-hidden="true" />}{cardLine}</span></span>
        <ChevronRight className="home-card-chevron" size={18} aria-hidden="true" />
      </button>
      {active ? <div className="home-card-foot">
        <span className="home-card-available"><span>카드로 쓸 수 있는 돈</span><strong data-testid="available-balance">{money(availableToSpend(state))}</strong></span>
        <button type="button" className="btn small neutral" data-testid="open-payment" onClick={onPay}>{card.locked ? '잠금 풀기' : '결제해 보기'}</button>
      </div> : <button type="button" className="btn neutral block home-card-next" data-testid="open-payment" onClick={onPay}>{PREPARING.includes(card.stage) ? '진행 상황 보기' : card.stage === 'rejected' ? '다시 신청하기' : '신청 이어서 하기'}</button>}
    </section>}

    <section className="live-card home-live" aria-label="리워드">
      <div className="live-card-head"><span className="live-label">리워드</span><button type="button" className="live-link" data-testid="open-rewards" onClick={onRewards}>혜택<ChevronRight size={16} aria-hidden="true" /></button></div>
      <div className="live-amount"><LiveRewards state={state} testId="available-rewards" /></div>
      <p className="live-caption">{state.reserve > 0 ? '리저브 보상이 1초마다 쌓여요.' : '리저브에 넣으면 1초마다 보상이 쌓여요.'}{state.rewardsAuto ? ' 결제할 때 먼저 써요.' : ''}</p>
      <button type="button" className="live-card-foot" data-testid="open-reserve-card" onClick={onReserve}>
        <span>리저브</span><strong>{money(state.reserve)}</strong><span className="live-rate">연 {percent(reserveTerms(state).rate)}</span><ChevronRight size={16} aria-hidden="true" />
      </button>
    </section>

    <section className="home-activity" aria-labelledby="home-activity-title">
      <div className="section-title"><h2 id="home-activity-title">최근 거래</h2>{state.transactions.length > 0 && <button type="button" className="link-button" onClick={onActivity}>전체<ChevronRight size={16} /></button>}</div>
      <ActivityList items={state.transactions.slice(0, 5)} payments={state.payments} operations={state.fundingOperations} onRefund={onRefund} empty="충전하거나 결제하면 여기에 보여요." />
    </section>
  </div>;
}
