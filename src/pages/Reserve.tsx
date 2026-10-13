import { LiveEarnings, Toggle, Won } from '../components/ui';
import { reserveTerms } from '../lib/engine';
import { money, percent, shortDate } from '../lib/format';
import { PLANS } from '../lib/policy';
import type { AppState } from '../lib/types';

export default function Reserve({ state, onMove, onAutoUse }: { state: AppState; onMove: (direction: 'in' | 'out') => void; onAutoUse: (enabled: boolean) => void }) {
  const terms = reserveTerms(state);
  const plan = PLANS[state.card.stage === 'active' ? state.card.plan : 'standard'];
  const daily = Math.min(state.reserve, terms.cap) * terms.rate / 365;
  return <div className="page reserve-page">
    <section className="live-card reserve-live" aria-label="리저브">
      <div className="live-card-head"><span className="live-label">리저브</span><span className="live-rate">연 {percent(terms.rate)}</span></div>
      <div className="live-amount"><Won value={state.reserve} className="hero-amount" testId="reserve-principal" /></div>
      <dl className="live-stats"><div><dt>오늘 쌓인 보상</dt><dd><LiveEarnings state={state} period="today" testId="reserve-accrual" /></dd></div><div><dt>지금까지</dt><dd><LiveEarnings state={state} period="total" /></dd></div></dl>
      <div className="button-pair"><button type="button" className="btn live-primary" onClick={() => onMove('in')}>넣기</button><button type="button" className="btn live-neutral" onClick={() => onMove('out')}>빼기</button></div>
    </section>

    <section className="plain-section">
      <p className="lead-text">{state.reserve > 0 ? `지금 금액이면 하루에 약 ${money(daily)}이 쌓여요.` : '잔액 일부를 리저브에 두면 1초마다 보상이 쌓여요.'} 보상은 1원이 될&nbsp;때마다 리워드에 들어가요.</p>
      <Toggle checked={state.reserveAuto} onChange={onAutoUse} label="잔액이 모자랄 때 리저브로 결제" detail="모자란 만큼만 리저브에서 빠져요." testId="reserve-auto" />
    </section>

    <details className="rule-details plain-section">
      <summary>보상 조건</summary>
      <ul>
        <li>기본 보상률 연 {percent(state.reserveRate)}에 멤버십 추가 보상이 붙어요. {plan.short} 멤버십은 {plan.reserveBonus ? `연 ${percent(plan.reserveBonus)}p를 더 받아요` : '추가 보상이 없어요'}.</li>
        <li>{money(terms.cap)}까지 보상이 쌓여요. 보상률은 바뀔 수 있고 단리로 계산해요.</li>
        <li>넣고 빼기는 1,000원부터, 수수료 없이 할 수 있어요.</li>
        <li>밖으로 보내려면 잔액으로 뺀 뒤 보내기를 이용해 주세요.</li>
        <li>예금이 아니라서 원금이 보장되지 않아요. 실제 운용과 상환&nbsp;조건은 제휴 후 정해요.</li>
      </ul>
      <div className="rate-history"><h3>기본 보상률 변경 기록</h3>{state.rateHistory.slice().reverse().slice(0, 5).map((item, index) => <div key={`${item.timestamp}-${index}`}><span>{shortDate(item.timestamp)}</span><strong>연 {percent(item.rate)}</strong></div>)}</div>
    </details>
  </div>;
}
