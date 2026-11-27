import { ArrowDownLeft, ArrowUpRight, CalendarClock, ChevronRight, Clock3, LockKeyhole } from 'lucide-react';
import CardHero from '../components/CardHero';
import CardVisual from '../components/CardVisual';
import { getCashbackSummary } from '../lib/rewards';
import './MoneyPages.css';
import { ActivityList, listedTransactions } from '../components/Activity';
import { Won } from '../components/ui';
import { availableToSpend, paymentPreview, renewalMessage, renewalNotice, reserveTerms } from '../lib/engine';
import { money, percent } from '../lib/format';
import { fundingStatusLabel, getHeldFundingWon, isFundingPending } from '../lib/movements';
import { fundingLabel, PLANS } from '../lib/policy';
import type { AppState, Payment, Transaction } from '../lib/types';

interface HomeProps {
  state: AppState;
  onDeposit: () => void;
  onSend: () => void;
  onCard: () => void;
  onPay: () => void;
  onPaymentSources: () => void;
  onReserve: () => void;
  onRewards: () => void;
  onActivity: () => void;
  onFunding: (id: string) => void;
  onRefund: (payment: Payment) => void;
  onDetail: (item: Transaction) => void;
}

const PREPARING = ['submitted', 'approved', 'issued'];

export default function Home({ state, onDeposit, onSend, onCard, onPay, onPaymentSources, onReserve, onRewards, onActivity, onFunding, onRefund, onDetail }: HomeProps) {
  const { card } = state;
  const plan = PLANS[card.plan];
  const pending = state.fundingOperations.filter(isFundingPending);
  const held = getHeldFundingWon(state);
  const recent = listedTransactions(state.transactions);
  const cashback = getCashbackSummary(state);
  const active = card.stage === 'active';
  const notice = renewalNotice(state, Date.now() + state.clockOffsetMs);
  const cardLine = active ? card.locked ? '잠겨 있어요' : `끝번호 ${card.last4}`
    : PREPARING.includes(card.stage) ? '만드는 중이에요'
      : card.stage === 'needs_info' ? '확인할 내용이 있어요'
        : card.stage === 'rejected' ? '승인되지 않았어요' : '신청을 이어서 할 수 있어요';

  return <div className="page home-page">
    {card.stage === 'not_applied' ? <section className="home-card-offer card-overview" aria-labelledby="offer-title">
      <div className="card-stage-art"><CardHero /></div>
      <div className="card-overview-copy">
        <h2 id="offer-title">Aqua 스탠다드</h2>
        <p>연회비 없이 시작하고, 결제할 때마다 {percent(PLANS.standard.cashbackRate)}를 돌려받아요.</p>
      </div>
      <button type="button" className="btn primary block" data-testid="open-payment" onClick={onPay}>카드 만들기</button>
    </section> : <section className="card-overview home-owned-card" aria-label="내 카드">
      <div className="card-stage-art"><CardVisual card={card} variant="hero" /></div>
      <button type="button" className="card-management" data-testid="card-cta" onClick={onCard}>
        <span><strong>{plan.name}</strong><span className={card.locked && active ? 'warning' : ''}>{card.locked && active && <LockKeyhole size={13} aria-hidden="true" />}{cardLine}</span></span>
        <span className="card-manage-link">카드 관리<ChevronRight size={16} aria-hidden="true" /></span>
      </button>
      {active ? <div className="card-spending">
        <div><span>{card.locked ? '카드 잠금 중' : '한 번에 결제 가능한 금액'}</span><strong data-testid="available-balance">{money(paymentPreview(state, 0).maximum)}</strong></div>
        <button type="button" className="btn primary" data-testid="open-payment" onClick={onPay}>{card.locked ? '잠금 풀기' : '결제해 보기'}</button>
        <button type="button" className="card-funding-link" onClick={onPaymentSources} data-testid="open-payment-sources">
          <span>결제에 쓸 잔액</span><span>{money(availableToSpend(state))}<ChevronRight size={16} aria-hidden="true" /></span>
        </button>
      </div> : <button type="button" className="btn primary block" data-testid="open-payment" onClick={onPay}>{PREPARING.includes(card.stage) ? '진행 상황 보기' : card.stage === 'rejected' ? '다시 신청하기' : '신청 이어서 하기'}</button>}
      {notice && <button type="button" className={`home-status home-renewal${notice.short ? ' short' : ''}`} data-testid="home-renewal" onClick={onCard}>
        <CalendarClock size={16} aria-hidden="true" />
        <span><strong>{renewalMessage(notice).title}</strong>{notice.short > 0 && <small>잔액이 {money(notice.short)} 부족해요</small>}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>}
    </section>}

    <section className="home-balance home-wallet" aria-labelledby="home-balance-label">
      <span className="eyebrow" id="home-balance-label">지갑 잔액</span>
      <Won value={state.spend} className="balance-figure" testId="spend-balance" />
      {held > 0 && <p className="balance-note">보내는 중 <strong data-testid="funding-held">{money(held)}</strong></p>}
      <button type="button" className="home-reserve-link" data-testid="open-reserve-card" onClick={onReserve}>
        <span>리저브 잔액</span><span><strong>{money(state.reserve)}</strong><small>연 {percent(reserveTerms(state).rate)}</small></span><ChevronRight size={16} aria-hidden="true" />
      </button>
      <div className="home-actions">
        <button type="button" className="btn primary" data-testid="open-deposit" onClick={onDeposit}><ArrowDownLeft size={17} aria-hidden="true" />충전</button>
        <button type="button" className="btn neutral" data-testid="open-send" onClick={onSend}><ArrowUpRight size={17} aria-hidden="true" />보내기</button>
      </div>
      {pending[0] && <button type="button" className="home-status" data-testid="home-funding-status" onClick={() => pending.length > 1 ? onActivity() : onFunding(pending[0].id)}>
        <Clock3 size={16} aria-hidden="true" />
        <span>{pending.length > 1 ? `처리 중인 입출금 ${pending.length}건` : `${fundingLabel(pending[0].symbol)} ${pending[0].kind === 'deposit' ? '입금' : '출금'} · ${fundingStatusLabel(pending[0].status)}`}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>}
    </section>

    <section className="home-benefit-overview" aria-labelledby="home-benefit-title">
      <div className="section-title"><h2 id="home-benefit-title">내 혜택</h2><button type="button" className="link-button" data-testid="open-rewards" onClick={onRewards}>상세 보기<ChevronRight size={16} aria-hidden="true" /></button></div>
      <div className="home-benefit-amounts">
        <div className="home-payback"><span>이번 달 확정 페이백</span><Won value={cashback.confirmed} testId="home-cashback-confirmed" />
          {cashback.pending > 0 && <small>확정 전 {money(cashback.pending)}</small>}
        </div>
        <div className="home-reward-balance"><span>사용 가능 리워드</span><Won value={state.rewards} testId="available-rewards" /></div>
      </div>
    </section>

    <section className="home-activity" aria-labelledby="home-activity-title">
      <div className="section-title"><h2 id="home-activity-title">최근 거래</h2>{recent.length > 0 && <button type="button" className="link-button" onClick={onActivity}>전체<ChevronRight size={16} /></button>}</div>
      <ActivityList items={recent.slice(0, 5)} payments={state.payments} operations={state.fundingOperations} onRefund={onRefund} onDetail={onDetail} empty="충전하거나 결제하면 여기에 보여요." />
    </section>
  </div>;
}
