import { NavRow, Toggle } from '../components/ui';
import { maskEmail, maskPhone } from '../lib/auth';
import { dateLabel, money, percent, ro } from '../lib/format';
import { PLANS } from '../lib/policy';
import type { Account, AppState } from '../lib/types';

interface SettingsProps {
  state: AppState;
  account: Account;
  cardStatus: string;
  go: (page: 'card' | 'activity' | 'limits' | 'channels' | 'notifications' | 'faq' | 'terms') => void;
  onRewardsAuto: (enabled: boolean) => void;
  onReserveAuto: (enabled: boolean) => void;
  onReceive: () => void;
  onPassword: () => void;
  onSignOut: () => void;
  onClose: () => void;
  onAdvanceDay: () => void;
  onRate: (rate: number) => void;
  onReset: () => void;
}

const channelText = (online: boolean, overseas: boolean) => online && overseas ? '모두 허용' : !online && !overseas ? '모두 막음' : online ? '해외 막음' : '온라인 막음';

export default function Settings({ state, account, cardStatus, go, onRewardsAuto, onReserveAuto, onReceive, onPassword, onSignOut, onClose, onAdvanceDay, onRate, onReset }: SettingsProps) {
  const plan = PLANS[state.card.plan];
  return <div className="page settings-page">
    <section className="profile" aria-label="내 정보">
      <span className="avatar" aria-hidden="true">{account.name.charAt(0)}</span>
      <div><strong>{account.name}</strong><span data-testid="own-tag">@{account.tag} · {maskEmail(account.email)}</span></div>
    </section>

    <section className="settings-group" aria-labelledby="settings-card">
      <h2 id="settings-card">카드</h2>
      <NavRow label="카드와 멤버십" value={state.card.stage === 'not_applied' ? '카드 없음' : `${plan.short} · ${cardStatus}`} onClick={() => go('card')} />
      <NavRow label="결제 한도" value={`1회 ${state.controls.perPayment / 10_000}만원`} testId="open-limits" onClick={() => go('limits')} />
      <NavRow label="온라인·해외 결제" value={channelText(state.controls.online, state.controls.overseas)} testId="open-channels" onClick={() => go('channels')} />
      <NavRow label="이용 내역" onClick={() => go('activity')} />
    </section>

    <section className="settings-group" aria-labelledby="settings-pay">
      <h2 id="settings-pay">결제 순서</h2>
      <Toggle checked={state.rewardsAuto} onChange={onRewardsAuto} label="리워드 먼저 쓰기" detail="결제할 때 리워드부터 빠져요." testId="rewards-auto" />
      <Toggle checked={state.reserveAuto} onChange={onReserveAuto} label="모자라면 리저브로 결제" detail="잔액이 모자란 만큼만 리저브에서 빠져요." testId="reserve-auto" />
    </section>

    <section className="settings-group" aria-labelledby="settings-account">
      <h2 id="settings-account">계정</h2>
      <NavRow label="내 태그와 QR" detail={account.findByPhone ? '휴대폰 번호로도 찾을 수 있어요' : '태그와 QR로 받아요'} value={`@${account.tag}`} testId="open-receive" onClick={onReceive} />
      <dl className="breakdown plain"><div><dt>이메일</dt><dd>{maskEmail(account.email)}</dd></div><div><dt>휴대폰</dt><dd>{maskPhone(account.phone)}</dd></div><div><dt>본인확인</dt><dd>{dateLabel(account.verifiedAt)}</dd></div></dl>
      <NavRow label="비밀번호 변경" testId="open-password" onClick={onPassword} />
      <NavRow label="알림" value={state.notifications.payments && state.notifications.funding ? '모두 받음' : '일부 끔'} testId="open-notifications" onClick={() => go('notifications')} />
      <button type="button" className="btn neutral block settings-signout" data-testid="sign-out" onClick={onSignOut}>로그아웃</button>
      <button type="button" className="text-danger-button" data-testid="open-closure" onClick={onClose}>회원 탈퇴</button>
    </section>

    <section className="settings-group" aria-labelledby="settings-fees">
      <h2 id="settings-fees">요금</h2>
      <dl className="breakdown plain">
        <div><dt>{plan.short} 멤버십</dt><dd>{plan.annualFee ? `연 ${money(plan.annualFee)}` : '무료'}</dd></div>
        {state.card.billingAt !== null && <div><dt>{state.card.nextPlan ? `${ro(PLANS[state.card.nextPlan].short)} 바뀌는 날` : '다음 갱신일'}</dt><dd>{dateLabel(state.card.billingAt)}</dd></div>}
        <div><dt>충전</dt><dd>무료</dd></div>
        <div><dt>Aqua 회원에게 보내기</dt><dd>무료</dd></div>
        <div><dt>지갑 주소로 보내기</dt><dd>네트워크 비용, 다른 코인은 +0.5%</dd></div>
      </dl>
    </section>

    <section className="settings-group" aria-labelledby="settings-help">
      <h2 id="settings-help">도움말</h2>
      <NavRow label="자주 묻는 질문" testId="open-faq" onClick={() => go('faq')} />
      <NavRow label="약관 및 정책" testId="open-terms" onClick={() => go('terms')} />
    </section>

    <details className="settings-group demo-tools" data-testid="demo-tools"><summary>체험 설정</summary><div className="details-body">
      <div className="demo-control"><div><strong>하루 지나기</strong><p>하루치 리저브 보상을 바로 쌓아요.</p></div><button type="button" className="btn small neutral" data-testid="advance-day" onClick={onAdvanceDay}>1일 진행</button></div>
      <div className="demo-control"><div><strong>리저브 기본 보상률</strong><p>바꾼 순간부터 쌓여요. 멤버십 추가 보상은 그대로 붙어요.</p></div><div className="rate-buttons">{[0.03, 0.05, 0.08].map((rate) => <button type="button" key={rate} className={`btn small${state.reserveRate === rate ? ' chosen' : ' neutral'}`} aria-pressed={state.reserveRate === rate} data-testid={`rate-${rate * 100}`} onClick={() => onRate(rate)}>{percent(rate)}</button>)}</div></div>
      <div className="demo-control"><div><strong>처음으로 되돌리기</strong><p>잔액, 카드, 내역을 처음 상태로 돌려요.</p></div><button type="button" className="btn small danger" data-testid="reset-demo" onClick={onReset}>초기화</button></div>
      <p className="small-note">체험 데이터는 이 브라우저에만 저장돼요.</p>
    </div></details>
  </div>;
}
