import type { RewardRecord, RewardsSnapshot } from '../../shared/api';
import './RewardsPanel.css';

interface RewardsPanelProps {
  rewards: RewardsSnapshot | null;
  saving: boolean;
  unresolved: boolean;
  message: string;
  error: string;
  onUseFirstChange: (enabled: boolean) => void;
  onRetry: () => void;
}

const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const signed = (value: number) => value === 0 ? '0원' : `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`;
const date = (value: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(value);
const labels: Record<RewardRecord['kind'], string> = {
  grant: '리워드 지급', cashback: '카드 페이백', card_authorize: '리워드 사용 승인',
  card_capture: '리워드 결제 확정', card_release: '리워드 승인 해제', card_refund: '리워드 환불',
  cashback_reversal: '페이백 조정', adjustment_offset: '조정액 반영',
};

export default function RewardsPanel({ rewards, saving, unresolved, message, error, onUseFirstChange, onRetry }: RewardsPanelProps) {
  const history = rewards?.history.slice(0, 50) ?? [];
  const rate = rewards ? `${Number((rewards.policy.rateBps / 100).toFixed(2))}%` : '';
  return <section className="sa-transactions sa-rewards-panel" aria-label="페이백과 리워드" data-testid="server-rewards-panel">
    {!rewards ? <div className="sa-empty-state">리워드를 불러오고 있어요.</div> : <>
      <div className="sa-benefits-grid">
        <div className="sa-rewards-month">
          <div className="sa-section-heading"><h2 id="cashback-heading" tabIndex={-1}>이번 달 페이백</h2><span>{rewards.cashback.month.replace('-', '. ')}</span></div>
          <dl className="sa-month-total">
            <dt>확정된 페이백</dt><dd data-testid="cashback-confirmed">{money(rewards.cashback.confirmedWon)}</dd>
          </dl>
          <p className="sa-rewards-policy">적립률 <b data-testid="rewards-policy-rate">{rate}</b>
            <span aria-hidden="true"> · </span>월 한도 <b data-testid="rewards-policy-cap">{money(rewards.policy.monthlyCapWon)}</b></p>
          {rewards.policy.monthlyCapWon > 0 && <meter className="sa-cashback-meter" min={0} max={rewards.policy.monthlyCapWon}
            value={rewards.policy.monthlyCapWon - rewards.cashback.remainingWon} aria-label="이번 달 사용한 페이백 한도" />}
          <dl className="sa-cashback-details">
            <div><dt>적립 대기</dt><dd data-testid="cashback-pending">{money(rewards.cashback.pendingWon)}</dd></div>
            <div><dt>남은 한도</dt><dd data-testid="cashback-remaining">{money(rewards.cashback.remainingWon)}</dd></div>
            <div><dt>환수 금액</dt><dd data-testid="cashback-reversed">{money(rewards.cashback.reversedWon)}</dd></div>
          </dl>
          {!rewards.programActive && <p className="sa-rewards-program" data-testid="rewards-program-status">새 페이백 적립 중지</p>}
        </div>
        <div className="sa-rewards-wallet">
          <div className="sa-section-heading"><div><h2>카드 리워드</h2><p>카드 결제에 사용할 수 있어요.</p></div></div>
      <dl className="sa-rewards-balances"><div><dt>사용 가능</dt><dd data-testid="rewards-available">{money(rewards.availableWon)}</dd></div><div><dt>결제대기</dt><dd data-testid="rewards-held">{money(rewards.heldWon)}</dd></div></dl>
      {rewards.adjustmentDueWon > 0 && <div className="sa-rewards-adjustment"><div><span>조정 대기</span><strong data-testid="rewards-adjustment">{money(rewards.adjustmentDueWon)}</strong></div><p>앞으로 지급될 리워드에서 먼저 반영해요. 원금에서는 차감하지 않아요.</p></div>}
      <div className="sa-rewards-preference"><div><strong>리워드 우선 사용</strong><p>결제할 때 리워드부터 사용해요.</p></div><button type="button" className={`sa-rewards-switch${rewards.useFirst ? ' on' : ''}`} role="switch" aria-checked={rewards.useFirst} aria-label="리워드 우선 사용" data-testid="rewards-use-first" disabled={saving || unresolved} onClick={() => onUseFirstChange(!rewards.useFirst)}><span /></button></div>
      {saving && <p className="sa-rewards-feedback" role="status">설정을 확인하고 있어요.</p>}
      {unresolved && !saving && <div className="sa-rewards-unknown" data-testid="rewards-preference-unknown"><p>확인되지 않은 설정 요청이 있어요. 결과 확인 전에는 다시 변경할 수 없어요.</p><button type="button" className="sa-secondary" data-testid="rewards-preference-retry" onClick={onRetry}>설정 결과 다시 확인</button></div>}
      {error && <p className="sa-error" role="alert" data-testid="rewards-preference-error">{error}</p>}
      {message && !saving && <p className="sa-rewards-feedback" role="status">{message}</p>}
      </div></div>
      <details className="sa-rewards-history" data-testid="rewards-history"><summary><span>리워드 이용 내역</span><span>{history.length}건</span></summary><p className="sa-rewards-rule">사용 가능 리워드의 실제 변동액이에요. 승인 때 확보한 리워드는 결제 확정 시 다시 차감하지 않아요.</p>{history.length ? history.map((record) => <details className="sa-rewards-record" key={record.id} data-testid={`rewards-record-${record.id}`} data-kind={record.kind}><summary><div><strong>{labels[record.kind]}</strong><span>{date(record.createdAt)}</span></div><strong className={record.availableDeltaWon > 0 ? 'positive' : ''} data-testid={`rewards-record-available-${record.id}`} data-delta={record.availableDeltaWon}>{record.availableDeltaWon === 0 ? '변동 없음' : signed(record.availableDeltaWon)}</strong></summary><dl><div><dt>사용 가능 변동</dt><dd>{signed(record.availableDeltaWon)}</dd></div><div><dt>결제대기 변동</dt><dd data-testid={`rewards-record-held-${record.id}`}>{signed(record.heldDeltaWon)}</dd></div><div><dt>조정 대기 변동</dt><dd data-testid={`rewards-record-adjustment-${record.id}`}>{signed(record.adjustmentDeltaWon)}</dd></div><div><dt>기록 금액</dt><dd>{money(record.amountWon)}</dd></div>{record.paymentId && <div><dt>카드 내역 번호</dt><dd>{record.paymentId}</dd></div>}</dl></details>) : <div className="sa-empty-state">아직 리워드 변동이 없어요.</div>}</details>
    </>}
  </section>;
}
