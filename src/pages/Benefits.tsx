import { ChevronRight } from 'lucide-react';
import { RewardHistory } from '../components/Activity';
import { LiveEarnings, LiveRewards, Toggle } from '../components/ui';
import { money, percent } from '../lib/format';
import { reserveTerms } from '../lib/engine';
import { getCashbackSummary } from '../lib/rewards';
import type { AppState } from '../lib/types';

export default function Benefits({ state, onReserve, onRewardsAuto }: { state: AppState; onReserve: () => void; onRewardsAuto: (enabled: boolean) => void }) {
  const cashback = getCashbackSummary(state);
  const used = Math.min(100, Math.max(0, cashback.allocated / cashback.cap * 100));
  const terms = reserveTerms(state);
  const daily = Math.min(state.reserve, terms.cap) * terms.rate / 365;
  return <div className="page benefits-page" data-testid="page-benefits">
    <section className="live-card" aria-label="리워드">
      <div className="live-card-head"><span className="live-label">리워드</span></div>
      <div className="live-amount"><LiveRewards state={state} testId="reward-balance" /></div>
      <p className="live-caption">페이백과 리저브 보상이 받기 버튼 없이 바로 쌓여요. 카드 결제에만 쓸 수 있어요.</p>
    </section>
    <section className="plain-section">
      <Toggle checked={state.rewardsAuto} onChange={onRewardsAuto} label="결제할 때 리워드 먼저 쓰기" testId="rewards-auto" />
    </section>

    <section className="plain-section cashback-summary" aria-labelledby="cashback-title">
      <div className="section-title"><h2 id="cashback-title">이번 달 페이백</h2><span className="chip accent" data-testid="cashback-rate">{percent(cashback.rate)}</span></div>
      <strong className="cashback-figure" data-testid="cashback-confirmed">{money(cashback.confirmed)}</strong>
      <div className="cashback-progress" role="progressbar" aria-label="이번 달 페이백 한도" aria-valuemin={0} aria-valuemax={cashback.cap} aria-valuenow={Math.min(cashback.cap, cashback.allocated)} aria-valuetext={`${money(cashback.allocated)} / ${money(cashback.cap)}`}><span className="cashback-progress-fill" style={{ width: `${used}%` }} /></div>
      <dl className="cashback-metrics"><div><dt>확정 전</dt><dd data-testid="cashback-pending">{money(cashback.pending)}</dd></div><div><dt>남은 한도</dt><dd data-testid="cashback-remaining">{money(cashback.remaining)}</dd></div><div><dt>월 한도</dt><dd>{money(cashback.cap)}</dd></div></dl>
      <details className="rule-details"><summary>페이백 기준</summary>
        <p>리워드로 낸 금액을 뺀 결제액의 {percent(cashback.rate)}를 돌려드려요. 한 달에 {money(cashback.cap)}까지예요.</p>
        <p>결제가 확정되면 리워드에 들어가고, 환불하면 그만큼 줄어요.</p>
        <p>지난달 결제가 이번 달에 확정되면 지난달 페이백으로 세요.</p>
      </details>
    </section>

    <section className="plain-section reserve-earnings" aria-labelledby="reserve-earnings-title">
      <div className="section-title"><h2 id="reserve-earnings-title">리저브 보상</h2><button type="button" className="link-button" onClick={onReserve}>리저브 보기<ChevronRight size={16} /></button></div>
      <dl className="breakdown plain"><div><dt>오늘</dt><dd><LiveEarnings state={state} period="today" testId="reserve-today" /></dd></div><div><dt>지금까지</dt><dd><LiveEarnings state={state} period="total" testId="reserve-total" /></dd></div><div><dt>하루 예상</dt><dd>약 {money(daily)}</dd></div></dl>
    </section>
    {state.rewardDebt > 0 && <p className="inline-notice warning">앞서 환불한 결제의 페이백 {money(state.rewardDebt)}은 다음에 쌓일 리워드에서 먼저 빼요.</p>}

    <section className="plain-section" aria-labelledby="reward-history-title">
      <div className="section-title"><h2 id="reward-history-title">리워드 내역</h2></div>
      <RewardHistory state={state} />
    </section>
  </div>;
}
