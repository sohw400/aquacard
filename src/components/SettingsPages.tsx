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
      <p className="panel-lead">한도를 낮춰 두면 카드 번호가 새어 나가도 피해를 줄일&nbsp;수 있어요. 최대 한도까지는 언제든 다시 올릴&nbsp;수&nbsp;있어요.</p>
      <div className="limit-list">{rows.map((row) => <div className="limit-row" key={row.key}>
        <div className="limit-head"><label htmlFor={`limit-${row.key}`}>{row.label}</label><strong data-testid={`limit-value-${row.key}`}>{money(row.value)}</strong></div>
        <input id={`limit-${row.key}`} data-testid={`limit-${row.key}`} type="range" min={row.min} max={row.max} step={LIMIT_STEP} value={row.value} aria-valuetext={money(row.value)} onChange={(event) => row.set(Number(event.target.value))} />
        <div className="limit-scale"><span>{manWon(row.min)}</span><span>최대 {manWon(row.max)}</span></div>
        {row.used && <p className="limit-used">{row.used.label} {money(row.used.value)} · 남은 한도 {money(Math.max(0, row.value - row.used.value))}</p>}
      </div>)}</div>
      <button type="button" className="btn primary block" data-testid="limits-save" disabled={!changed} onClick={() => onSave({ perPayment, daily, monthly })}>저장</button>
    </section>
    <p className="panel-footnote">최대 한도는 1회 {manWon(POLICY.perPaymentLimit)}, 하루 {manWon(POLICY.dailyPaymentLimit)}, 한 달 {manWon(POLICY.monthlyPaymentLimit)}이에요. 하루 한도는 매일 자정, 한 달 한도는 매달 1일에 한국 시간 기준으로 다시 채워져요.</p>
  </div>;
}

export function ChannelsPage({ state, onChange }: { state: AppState; onChange: (channel: 'online' | 'overseas', enabled: boolean) => void }) {
  return <div className="page-stack settings-detail" data-testid="page-channels">
    <section className="panel">
      <Switch checked={state.controls.online} label="온라인 결제" detail="쇼핑몰이나 앱에서 카드 번호로 결제해요." testId="channel-online" onChange={(value) => onChange('online', value)} />
      <Switch checked={state.controls.overseas} label="해외 결제" detail="해외 가맹점과 해외 사이트에서 결제해요." testId="channel-overseas" onChange={(value) => onChange('overseas', value)} />
      <p className="panel-caption">꺼 두면 해당 결제는 바로 거절돼요. 매장 결제와 휴대폰 결제는 그대로 쓸 수 있어요.</p>
    </section>
  </div>;
}

export function NotificationsPage({ state, onChange }: { state: AppState; onChange: (key: 'payments' | 'funding' | 'marketing', enabled: boolean) => void }) {
  const { notifications } = state;
  return <div className="page-stack settings-detail" data-testid="page-notifications">
    <section className="panel">
      <h2 className="panel-title">서비스 알림</h2>
      <Switch checked={notifications.payments} label="결제 알림" detail="카드 결제와 환불을 바로 알려 드려요." testId="notify-payments" onChange={(value) => onChange('payments', value)} />
      <Switch checked={notifications.funding} label="입출금 알림" detail="충전과 보내기 진행 상황, 회원에게 받은 돈을 알려 드려요." testId="notify-funding" onChange={(value) => onChange('funding', value)} />
    </section>
    <section className="panel">
      <h2 className="panel-title">광고성 정보 수신</h2>
      <Switch checked={notifications.marketing} label="혜택·이벤트 소식" detail="새 혜택과 이벤트 소식을 앱 알림으로 받아요." testId="notify-marketing" onChange={(value) => onChange('marketing', value)} />
      <p className="panel-caption" data-testid="marketing-status">{notifications.marketingChangedAt ? `${dateLabel(notifications.marketingChangedAt)}에 ${notifications.marketing ? '동의' : '철회'}했어요.` : '아직 동의하지 않았어요.'} 언제든 바꿀&nbsp;수&nbsp;있어요.</p>
    </section>
    <p className="panel-footnote">체험판에서는 실제 알림을 보내지 않아요.</p>
  </div>;
}

const FAQ: [string, [string, string][]][] = [
  ['충전과 보내기', [
    ['어떤 코인으로 충전할 수 있나요?', '원화 스테이블코인, USDC, USDT, BTC, ETH로 충전할 수 있어요. 다른 코인은 받는 즉시 원화 스테이블로 바뀌어 잔액에 들어가요.'],
    ['충전하거나 보낼 때 수수료는 얼마인가요?', '충전 수수료는 없어요. 보낼 때는 네트워크 비용이 들어요. 다른 코인으로 바꿔 보내면 전환 수수료 0.5%가 붙어요.'],
    ['거래소에서 바로 보낼 수 있나요?', '네. 충전 화면에서 국내 거래소를 고르면 주소와 보내는 방법을 알려 드려요. 100만원 이상 보낼 때 거래소가 받는\u00a0곳을 물으면 Aqua를 골라 주세요.'],
    ['다른 Aqua 회원에게는 어떻게 보내나요?', '보내기 › Aqua 회원에게에서 태그, 휴대폰 번호, 이메일로 찾거나 QR 코드 찍기로 상대의 QR을 찍어 보내요. 수수료 없이 바로 가요. 휴대폰 번호와 이메일은 상대가 그 방법으로 찾기를 켰을 때만 찾을\u00a0수 있어요.'],
  ]],
  ['리저브와 리워드', [
    ['리저브 보상은 언제 받나요?', '1초마다 계산해서 1원이 될\u00a0때마다 리워드에 바로 더해요. 따로 받을 필요는 없어요.'],
    ['리워드는 어디에 쓰나요?', '카드 결제에만 쓸 수 있어요. 결제하면 리워드에서 먼저 빠져요. 밖으로 보내거나 코인으로 바꿀 수는 없어요.'],
    ['리저브는 예금인가요?', '예금이 아니라서 원금이 보장되지 않아요. 보상률은 바뀔 수 있어요. 실제 운용과 상환\u00a0조건은 제휴 후 정해요.'],
  ]],
  ['카드', [
    ['페이백은 언제 들어오나요?', `결제가 확정되면 리워드로 들어와요. 스탠다드 ${PLANS.standard.cashbackRate * 100}%, 프리미엄 ${PLANS.premium.cashbackRate * 100}%, 프라이빗 ${PLANS.private.cashbackRate * 100}%예요.`],
    ['멤버십 연회비는 어떻게 내나요?', '프리미엄과 프라이빗은 가입한 날 연회비를 잔액에서 내고, 1년마다 같은 날 다시 내요. 그날 잔액이 모자라면 스탠다드로 바뀌어요.'],
    ['카드를 잃어버렸어요.', '카드 화면의 분실·도난 신고에서 지금 카드를 바로 막고 새 번호로 다시 받을 수 있어요. 급하면 먼저 카드를 잠가 주세요.'],
    ['멤버십을 올리면 실물카드는 어떻게 되나요?', '이미 받은 실물카드가 있으면 새 등급 카드(프리미엄은 메탈, 프라이빗은 골드)를 무료로 보내 드려요. 받아서 쓰기 시작할 때까지 지금 카드를 그대로 쓰고, 카드 번호는 바뀌지 않아요.'],
  ]],
  ['계정', [
    ['탈퇴하면 남은 돈은 어떻게 되나요?', '탈퇴하려면 카드를 먼저 해지해 주세요. 리저브에 있는 돈까지 잔액으로 옮긴 뒤 모두 밖으로 보내야 해요. 리워드는 보낼 수 없어서 탈퇴하면 사라져요.'],
  ]],
];

export function FaqPage() {
  return <div className="page-stack settings-detail" data-testid="page-faq">
    {FAQ.map(([group, items]) => <section className="panel flush faq-group" key={group}><h2 className="panel-title">{group}</h2>{items.map(([question, answer]) => <details className="faq-item" key={question}><summary>{question}</summary><p>{answer}</p></details>)}</section>)}
    <section className="panel"><h2 className="panel-title">고객센터</h2><p className="panel-caption">출시하면 앱 상담과 전화 상담을 열어요. 체험판에서는 상담을 받지 않아요.</p></section>
  </div>;
}

const TERMS: [string, string][] = [
  ['서비스 이용약관', 'Aqua 계정, 충전·출금, 리저브와 리워드 이용 조건을 담아요.'],
  ['전자금융거래 이용약관', '카드 결제와 자금 이동의 처리 기준, 오류 정정과 손해 책임을 담아요.'],
  ['카드 회원 약관', '카드 발급사가 정하는 회원 약관이에요. 발급사와 제휴한 뒤에 올려요.'],
  ['개인정보 처리방침', '가입, 본인확인, 결제에 쓰는 정보와 보관 기간, 제3자 제공 내역을 담아요.'],
  ['가상자산 이용 유의사항', '코인 가격 변동, 네트워크 선택, 트래블룰처럼 입출금 전에 알아야 할 내용이에요.'],
  ['리저브 상품 설명서', '보상률이 바뀌는 방식, 원금 비보장, 운용 구조를 설명해요.'],
];

export function TermsPage() {
  return <div className="page-stack settings-detail" data-testid="page-terms">
    <section className="panel flush faq-group">{TERMS.map(([title, summary]) => <details className="faq-item" key={title}><summary>{title}</summary><p>{summary}</p><p className="faq-note">본문은 법률 검토를 마치고 출시 전에 올려요.</p></details>)}</section>
    <p className="panel-footnote">실제 금융 서비스가 아닌 체험판이에요.</p>
  </div>;
}
