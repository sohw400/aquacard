import { ArrowDownLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import './MoneyPages.css';
import './WalletActivity.css';
import { LiveEarnings, Won } from '../components/ui';
import { ReserveSwitch } from '../components/PaymentSources';
import { reserveTerms } from '../lib/engine';
import { money, percent, shortDate } from '../lib/format';
import { PLANS } from '../lib/policy';
import type { AppState } from '../lib/types';

export default function Reserve({ state, onMove, onAutoUse, onRewards }: { state: AppState; onRewards: () => void; onMove: (direction: 'in' | 'out') => void; onAutoUse: (enabled: boolean) => void }) {
  const terms = reserveTerms(state);
  const plan = PLANS[state.card.stage === 'active' ? state.card.plan : 'standard'];
  const daily = Math.min(state.reserve, terms.cap) * terms.rate / 365;
  return <div className="page reserve-page wallet-ledger">
    <section className="reserve-live principal-panel" aria-label="리저브">
      <div className="principal-heading"><h2>리저브에 보관 중인 돈</h2><span className="reserve-rate">보상률 <strong className="live-rate">연 {percent(terms.rate)}</strong></span></div>
      <Won value={state.reserve} className="principal-amount" testId="reserve-principal" />
      <p className="principal-note">필요한 만큼 지갑으로 옮길 수 있어요.</p>
      <div className="principal-controls">
        <div className="wallet-reference"><span>지갑 잔액</span><strong>{money(state.spend)}</strong></div>
        <div className="button-pair">
          <button type="button" className="btn primary" onClick={() => onMove('in')}><ArrowDownLeft size={17} aria-hidden="true" />넣기</button>
          <button type="button" className="btn neutral" onClick={() => onMove('out')}><ArrowUpRight size={17} aria-hidden="true" />빼기</button>
        </div>
      </div>
    </section>
    <section className="plain-section reserve-earned" aria-labelledby="reserve-earned-title">
      <div className="section-title"><h2 id="reserve-earned-title">리저브 보상</h2><button type="button" className="link-button" onClick={onRewards}>내 리워드 보기<ChevronRight size={16} aria-hidden="true" /></button></div>
      <dl className="reserve-earnings-list">
        <div><dt>오늘 쌓인 보상</dt><dd><LiveEarnings state={state} period="today" testId="reserve-accrual" /></dd></div>
        <div><dt>누적 보상</dt><dd><LiveEarnings state={state} period="total" /></dd></div>
      </dl>
      <p className="ledger-note">{state.reserve > 0 && <>현재 잔액 기준 하루 약 {money(daily)}. </>}보상은 1원이 될 때마다 리워드에 들어가요.</p>
    </section>
    <section className="reserve-preference" aria-label="카드 결제 설정">
      <ReserveSwitch checked={state.reserveAuto} onChange={onAutoUse} />
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
