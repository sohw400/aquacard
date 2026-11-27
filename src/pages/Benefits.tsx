import { ChevronRight } from 'lucide-react';
import './MoneyPages.css';
import './WalletActivity.css';
import { RewardHistory } from '../components/Activity';
import { LiveEarnings, Won } from '../components/ui';
import { RewardSwitch } from '../components/PaymentSources';
import { money, percent } from '../lib/format';
import { reserveTerms } from '../lib/engine';
import { getCashbackSummary } from '../lib/rewards';
import type { AppState } from '../lib/types';

export default function Benefits({ state, onReserve, onRewardsAuto }: { state: AppState; onReserve: () => void; onRewardsAuto: (enabled: boolean) => void }) {
  const cashback = getCashbackSummary(state);
  const used = cashback.cap ? Math.min(100, 100 * cashback.allocated / cashback.cap) : 0;
  const terms = reserveTerms(state);
  const daily = Math.min(state.reserve, terms.cap) * terms.rate / 365;
  return <div className="page benefits-page wallet-ledger" data-testid="page-benefits">
    <section className="benefit-balance rewards-account" aria-labelledby="rewards-account-title">
      <h2 id="rewards-account-title">결제에 쓸 수 있는 리워드</h2>
      <Won value={state.rewards} className="rewards-amount" testId="reward-balance" />
      <p className="ledger-note">확정된 페이백과 리저브 보상이 자동으로 쌓여요. 카드 결제에만 쓸 수 있어요.</p>
      <div className="reward-preference"><RewardSwitch checked={state.rewardsAuto} onChange={onRewardsAuto} /></div>
    </section>

    <section className="plain-section cashback-summary" aria-labelledby="cashback-title">
      <div className="section-title"><h2 id="cashback-title">이번 달 페이백</h2><span className="cashback-rate">적립률 <strong data-testid="cashback-rate">{percent(cashback.rate)}</strong></span></div>
      <dl className="cashback-bookings">
        <div><dt>적립 완료</dt><dd data-testid="cashback-confirmed">{money(cashback.confirmed)}</dd></div>
        <div><dt>적립 예정</dt><dd data-testid="cashback-pending">{money(cashback.pending)}</dd></div>
      </dl>
      {cashback.pending > 0 && <p className="cashback-pending-note">결제가 확정되면 예정 금액이 리워드에 들어와요.</p>}
      <div className="cashback-cap"><span>남은 한도 <strong data-testid="cashback-remaining">{money(cashback.remaining)}</strong></span><span>월 {money(cashback.cap)}</span></div>
      <div className="cashback-progress" role="progressbar" aria-label="이번 달 페이백 한도" aria-valuemin={0} aria-valuemax={cashback.cap} aria-valuenow={Math.min(cashback.cap, cashback.allocated)} aria-valuetext={`${money(cashback.allocated)} / ${money(cashback.cap)}`}>
        <span className="cashback-progress-fill" style={{ width: used + '%' }} />
      </div>
      <details className="rule-details"><summary>페이백 기준</summary>
        <p>리워드로 낸 금액을 뺀 결제액의 {percent(cashback.rate)}를 돌려드려요. 한&nbsp;달에 {money(cashback.cap)}까지예요.</p>
        <p>결제가 확정되면 리워드에 들어가고, 환불하면 그만큼 줄어요.</p>
        <p>지난달 결제는 이번 달에 확정돼도 지난달 페이백으로 계산해요.</p>
      </details>
    </section>

    <section className="plain-section reserve-earnings" aria-labelledby="reserve-earnings-title">
      <div className="section-title"><h2 id="reserve-earnings-title">리저브 보상</h2><button type="button" className="link-button" onClick={onReserve}>리저브 보기<ChevronRight size={16} /></button></div>
      <dl className="breakdown plain"><div><dt>오늘</dt><dd><LiveEarnings state={state} period="today" testId="reserve-today" /></dd></div><div><dt>지금까지</dt><dd><LiveEarnings state={state} period="total" testId="reserve-total" /></dd></div><div><dt>하루 예상</dt><dd>약 {money(daily)}</dd></div></dl>
    </section>
    {state.rewardDebt > 0 && <p className="inline-notice warning">앞서 환불한 결제의 페이백 {money(state.rewardDebt)}은 다음에 쌓일 리워드에서 먼저 빼요.</p>}

    <section className="plain-section benefit-history" aria-labelledby="reward-history-title">
      <div className="section-title"><h2 id="reward-history-title">리워드 내역</h2></div>
      <RewardHistory state={state} />
    </section>
  </div>;
}
