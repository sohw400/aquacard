import { Toggle } from './ui';
import { money } from '../lib/format';
import type { AppState } from '../lib/types';
import './PaymentSettings.css';

type SwitchProps = { checked: boolean; onChange: (enabled: boolean) => void };

export function RewardSwitch(props: SwitchProps) {
  return <Toggle {...props} label="결제할 때 리워드 쓰기" detail="켜면 지갑보다 먼저 쓰고, 끄면 리워드를 모아 둬요." testId="rewards-auto" />;
}

export function ReserveSwitch(props: SwitchProps) {
  return <Toggle {...props} label="지갑 부족분을 리저브에서 쓰기" detail="지갑 잔액이 부족할 때만 리저브에 넣어 둔 돈을 써요." testId="reserve-auto" />;
}

export default function PaymentSources({ state, onRewardsAuto, onReserveAuto }: {
  state: AppState; onRewardsAuto: SwitchProps['onChange']; onReserveAuto: SwitchProps['onChange'];
}) {
  return <>
    <RewardSwitch checked={state.rewardsAuto} onChange={onRewardsAuto} />
    <ReserveSwitch checked={state.reserveAuto} onChange={onReserveAuto} />
    <div className="funding-order" aria-live="polite" aria-atomic="true">
      <h3>사용 순서</h3>
      <ol data-testid="funding-order">
        {state.rewardsAuto && <li><span>리워드</span><strong>{money(state.rewards)}</strong></li>}
        <li><span>지갑 잔액</span><strong>{money(state.spend)}</strong></li>
        {state.reserveAuto && <li><span>리저브 잔액</span><strong>{money(state.reserve)}</strong></li>}
      </ol>
    </div>
  </>;
}
