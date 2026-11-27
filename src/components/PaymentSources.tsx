import { Toggle, Won } from './ui';
import { availableToSpend } from '../lib/engine';
import { money } from '../lib/format';
import type { AppState } from '../lib/types';
import './PaymentSettings.css';

type SwitchProps = { checked: boolean; onChange: (enabled: boolean) => void };

export function RewardSwitch(props: SwitchProps) {
  return <Toggle {...props} label="결제할 때 리워드 쓰기" detail={props.checked ? '적립한 리워드를 지갑 잔액보다 먼저 써요.' : '리워드는 쓰지 않고 모아 둬요.'} testId="rewards-auto" />;
}

export function ReserveSwitch(props: SwitchProps) {
  return <Toggle {...props} label="지갑 부족분을 리저브에서 쓰기" detail={props.checked ? '모자란 금액만 리저브 원금에서 빼요.' : '리저브에 넣어 둔 원금은 쓰지 않아요.'} testId="reserve-auto" />;
}

export default function PaymentSources({ state, onRewardsAuto, onReserveAuto }: {
  state: AppState; onRewardsAuto: SwitchProps['onChange']; onReserveAuto: SwitchProps['onChange'];
}) {
  const available = availableToSpend(state);
  const sources = [
    ...(state.rewardsAuto ? [{ name: '리워드', amount: state.rewards }] : []),
    { name: '지갑 잔액', amount: state.spend },
    ...(state.reserveAuto ? [{ name: '리저브 잔액', amount: state.reserve }] : []),
  ];
  return <div className="funding-preferences">
    <section className="funding-order" aria-labelledby="funding-total-label">
      <header>
        <h2 id="funding-total-label">사용할 잔액 합계</h2>
        <Won value={available} testId="sources-total" />
      </header>
      <h3>사용 순서</h3>
      <ol data-testid="funding-order" aria-live="polite" aria-atomic="true">
        {sources.map(source => <li key={source.name}><span>{source.name}</span><strong>{money(source.amount)}</strong></li>)}
      </ol>
    </section>
    <section className="funding-options" aria-labelledby="funding-options-label">
      <h2 id="funding-options-label">결제 설정</h2>
      <RewardSwitch checked={state.rewardsAuto} onChange={onRewardsAuto} />
      <ReserveSwitch checked={state.reserveAuto} onChange={onReserveAuto} />
    </section>
  </div>;
}
