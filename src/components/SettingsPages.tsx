import { useState } from 'react';
import { LIMIT_STEP } from '../lib/engine';
import { dateLabel, money } from '../lib/format';
import { PLANS, POLICY } from '../lib/policy';
import type { AppState, PaymentControls } from '../lib/types';

const manWon = (value: number) => `${(value / 10_000).toLocaleString('ko-KR')}만원`;

function Switch({ checked, label, detail, testId, onChange }: { checked: boolean; label: string; detail: string; testId: string; onChange: (value: boolean) => void }) {
  return <div className="toggle-row"><div><strong>{label}</strong><p>{detail}</p></div><button type="button" className={`switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}><span /></button></div>;
}

/** Holder-set limits within the issuer's maximums; each limit can't sit below the shorter one. */
export function LimitsPage({ state, onSave }: { state: AppState; onSave: (limits: Pick<PaymentControls, 'perPayment' | 'daily' | 'monthly'>) => boolean }) {
  const [perPayment, setPerPayment] = useState(state.controls.perPayment);
  const [daily, setDaily] = useState(state.controls.daily);
  const [monthly, setMonthly] = useState(state.controls.monthly);
  const changed = perPayment !== state.controls.perPayment || daily !== state.controls.daily || monthly !== state.controls.monthly;
  const rows = [
    { key: 'perPayment', label: '1회 한도', value: perPayment, max: POLICY.perPaymentLimit, min: LIMIT_STEP, used: null,
      set: (value: number) => { setPerPayment(value); if (daily < value) setDaily(value); if (monthly < Math.max(daily, value)) setMonthly(Math.max(daily, value)); } },
    { key: 'daily', label: '하루 한도', value: daily, max: POLICY.dailyPaymentLimit, min: perPayment, used: { label: '오늘 쓴 금액', value: state.dailySpent },
      set: (value: number) => { setDaily(value); if (monthly < value) setMonthly(value); } },
    { key: 'monthly', label: '한 달 한도', value: monthly, max: POLICY.monthlyPaymentLimit, min: daily, used: { label: '이번 달 쓴 금액', value: state.monthlySpent },
      set: (value: number) => setMonthly(value) },
  ] as const;

  return <div className="page-stack settings-detail" data-testid="page-limits">
    <section className="panel">
      <p className="panel-lead">한도를 낮춰 두면 카드 번호가 새어도 피해가 줄어듭니다. 최대 한도까지는 언제든 다시 올릴&nbsp;수&nbsp;있습니다.</p>
      <div className="limit-list">{rows.map((row) => <div className="limit-row" key={row.key}>
        <div className="limit-head"><label htmlFor={`limit-${row.key}`}>{row.label}</label><strong data-testid={`limit-value-${row.key}`}>{money(row.value)}</strong></div>
        <input id={`limit-${row.key}`} data-testid={`limit-${row.key}`} type="range" min={row.min} max={row.max} step={LIMIT_STEP} value={row.value} aria-valuetext={money(row.value)} onChange={(event) => row.set(Number(event.target.value))} />
        <div className="limit-scale"><span>{manWon(row.min)}</span><span>최대 {manWon(row.max)}</span></div>
        {row.used && <p className="limit-used">{row.used.label} {money(row.used.value)} · 남은 한도 {money(Math.max(0, row.value - row.used.value))}</p>}
      </div>)}</div>
      <button type="button" className="btn primary block" data-testid="limits-save" disabled={!changed} onClick={() => onSave({ perPayment, daily, monthly })}>저장</button>
    </section>
    <p className="panel-footnote">최대 한도는 1회 {manWon(POLICY.perPaymentLimit)}, 하루 {manWon(POLICY.dailyPaymentLimit)}, 한 달 {manWon(POLICY.monthlyPaymentLimit)}입니다. 하루와 한 달 한도는 결제를 승인한 날짜(한국 시간) 기준으로 다시 채워집니다.</p>
  </div>;
}

export function ChannelsPage({ state, onChange }: { state: AppState; onChange: (channel: 'online' | 'overseas', enabled: boolean) => void }) {
  return <div className="page-stack settings-detail" data-testid="page-channels">
    <section className="panel">
      <Switch checked={state.controls.online} label="온라인 결제" detail="쇼핑몰과 앱에서 카드 번호로 결제합니다." testId="channel-online" onChange={(value) => onChange('online', value)} />
      <Switch checked={state.controls.overseas} label="해외 결제" detail="해외 가맹점과 해외 사이트 결제입니다." testId="channel-overseas" onChange={(value) => onChange('overseas', value)} />
      <p className="panel-caption">꺼 두면 그 결제는 바로 거절됩니다. 매장 결제와 휴대폰 결제는 그대로 쓸 수 있습니다.</p>
    </section>
  </div>;
}

export function NotificationsPage({ state, onChange }: { state: AppState; onChange: (key: 'payments' | 'funding' | 'marketing', enabled: boolean) => void }) {
  const { notifications } = state;
  return <div className="page-stack settings-detail" data-testid="page-notifications">
    <section className="panel">
      <h2 className="panel-title">서비스 알림</h2>
      <Switch checked={notifications.payments} label="결제 알림" detail="카드 결제와 환불을 바로 알려 드립니다." testId="notify-payments" onChange={(value) => onChange('payments', value)} />
      <Switch checked={notifications.funding} label="입출금 알림" detail="충전과 출금 진행 상황을 알려 드립니다." testId="notify-funding" onChange={(value) => onChange('funding', value)} />
    </section>
    <section className="panel">
      <h2 className="panel-title">광고성 정보 수신</h2>
      <Switch checked={notifications.marketing} label="혜택·이벤트 소식" detail="새 혜택과 이벤트를 앱 알림으로 받습니다." testId="notify-marketing" onChange={(value) => onChange('marketing', value)} />
      <p className="panel-caption" data-testid="marketing-status">{notifications.marketingChangedAt ? `${dateLabel(notifications.marketingChangedAt)}에 ${notifications.marketing ? '동의' : '철회'}했습니다.` : '아직 동의하지 않았습니다.'} 언제든 바꿀&nbsp;수&nbsp;있습니다.</p>
    </section>
    <p className="panel-footnote">체험판은 실제 알림을 보내지 않습니다.</p>
  </div>;
}

const FAQ: [string, [string, string][]][] = [
  ['충전과 출금', [
    ['어떤 코인으로 충전할 수 있나요?', '원화 스테이블코인과 USDC·USDT·BTC·ETH를 받습니다. 원화 스테이블이 아닌 코인은 받는 대로 원화 스테이블로 바꿔 결제 잔액에 넣습니다.'],
    ['충전과 출금 수수료는 얼마인가요?', '충전은 수수료가 없습니다. 출금할 때는 네트워크 비용이 들고, 다른 코인으로 바꿔 보내면 전환 수수료 0.5%가 붙습니다.'],
    ['거래소에서 바로 보낼 수 있나요?', '네. 충전에서 보내는 곳을 국내 거래소로 고르면 주소와 보내는 순서를 안내합니다. 100만원 이상은 거래소가 받는 곳을 물으니 Aqua를 고르세요.'],
  ]],
  ['리저브와 리워드', [
    ['리저브 보상은 언제 받나요?', '1초마다 계산하고 1원이 될 때마다 리워드에 바로 더합니다. 따로 받는 버튼은 없습니다.'],
    ['리워드는 어디에 쓰나요?', '카드 결제에만 씁니다. 결제하면 리워드에서 먼저 빠지고, 출금하거나 코인으로 바꿀 수는 없습니다.'],
    ['리저브는 예금인가요?', '예금이 아니며 원금이 보장되지 않습니다. 보상률은 바뀔 수 있고 실제 운용과 상환 조건은 제휴 후 정합니다.'],
  ]],
  ['카드', [
    ['페이백은 언제 들어오나요?', `결제가 확정되면 리워드로 들어옵니다. Basic은 ${PLANS.basic.cashbackRate * 100}%(월 ${money(PLANS.basic.cashbackCap)}까지), Plus는 ${PLANS.plus.cashbackRate * 100}%(월 ${money(PLANS.plus.cashbackCap)}까지)입니다.`],
    ['Plus 이용료는 어떻게 내나요?', `매달 같은 날 결제 잔액에서 ${money(PLANS.plus.monthlyFee)}이 나갑니다. 그날 잔액이 모자라면 Basic으로 바뀝니다.`],
    ['카드를 잃어버렸어요.', '카드 관리의 분실·도난 신고로 지금 카드를 바로 막고 새 번호로 다시 발급할 수 있습니다. 급하면 일시 잠금부터 켜 주세요.'],
  ]],
  ['계정', [
    ['탈퇴하면 남은 돈은 어떻게 되나요?', '탈퇴 전에 카드를 해지하고, 리저브는 결제 잔액으로 옮긴 뒤 잔액을 모두 출금해야 합니다. 출금할 수 없는 리워드는 탈퇴하면 사라집니다.'],
  ]],
];

export function FaqPage() {
  return <div className="page-stack settings-detail" data-testid="page-faq">
    {FAQ.map(([group, items]) => <section className="panel flush faq-group" key={group}><h2 className="panel-title">{group}</h2>{items.map(([question, answer]) => <details className="faq-item" key={question}><summary>{question}</summary><p>{answer}</p></details>)}</section>)}
    <section className="panel"><h2 className="panel-title">고객센터</h2><p className="panel-caption">출시하면 앱 상담과 전화 상담을 엽니다. 체험판은 상담을 받지 않습니다.</p></section>
  </div>;
}

const TERMS: [string, string][] = [
  ['서비스 이용약관', 'Aqua 계정, 충전·출금, 리저브와 리워드 이용 조건을 담습니다.'],
  ['전자금융거래 이용약관', '카드 결제와 자금 이동의 처리 기준, 오류 정정과 손해 책임을 담습니다.'],
  ['카드 회원 약관', '카드 발급사가 정하는 회원 약관입니다. 발급사 제휴 후 붙입니다.'],
  ['개인정보 처리방침', '가입·본인확인·결제에 쓰는 정보와 보관 기간, 제3자 제공 내역을 담습니다.'],
  ['가상자산 이용 유의사항', '코인 가격 변동, 네트워크 선택, 트래블룰 등 입출금 전에 알아야 할 내용입니다.'],
  ['리저브 상품 설명서', '보상률이 바뀌는 방식과 원금 비보장, 운용 구조를 설명합니다.'],
];

export function TermsPage() {
  return <div className="page-stack settings-detail" data-testid="page-terms">
    <section className="panel flush faq-group">{TERMS.map(([title, summary]) => <details className="faq-item" key={title}><summary>{title}</summary><p>{summary}</p><p className="faq-note">본문은 법률 검토를 마친 뒤 출시 전에 게시합니다.</p></details>)}</section>
    <p className="panel-footnote">Aqua 체험판 · 실제 금융 서비스가 아닙니다.</p>
  </div>;
}
