import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, CalendarClock, Check, ChevronLeft, CircleAlert, Clock3, CreditCard,
  Eye, EyeOff, LockKeyhole, MapPin, Package, RefreshCw, Smartphone, Truck, UnlockKeyhole,
} from 'lucide-react';
import { cardApplicationFee, upgradePhysical } from '../lib/engine';
import { addressLine } from '../lib/address';
import { maskPhone } from '../lib/auth';
import { dateLabel, josa, money, percent, ro } from '../lib/format';
import { physicalCardName, PLAN_ORDER, PLANS, POLICY } from '../lib/policy';
import type { Account, Action, CardStage, CardState, DeliveryStage, MobileWallet, PaymentControls, Plan, ShippingAddress } from '../lib/types';
import AddressSheet from './AddressSheet';
import { PinSheet } from './SecuritySheets';
import WalletSheet, { WALLET_NAMES } from './WalletSheet';
import CardActionSheet from './CardActionSheet';
import CardVisual from './CardVisual';
import TierCard from './TierCard';
import { NavRow } from './ui';
import heroCards from '../assets/aqua-cards.webp';
import './CardApplication.css';

interface CardApplicationProps {
  card: CardState;
  account: Account;
  /** Spend balance that card fees come out of. */
  spend: number;
  controls: PaymentControls;
  onOpenLimits: () => void;
  onOpenChannels: () => void;
  /** Opens the demo payment sheet for an active card. */
  onPay: () => void;
  onChange: (next: CardState) => void;
  /** Runs an engine action; false when it was refused (the reason is already shown). */
  onAction: (action: Action, message?: string) => boolean;
  onDeposit: () => void;
  onNotify: (message: string) => void;
}

type Sheet = { kind: 'plan'; plan: Plan } | { kind: 'physical' } | { kind: 'reissue' } | { kind: 'close' } | { kind: 'replacement' };

const won = money;
const steps = ['본인확인', '멤버십', '신청 확인'];
const stepByStage: Partial<Record<CardStage, number>> = { identity: 0, plan: 1, details: 1, review: 2 };
const autoDelays: Partial<Record<CardStage, number>> = { submitted: 1_400, approved: 500, issued: 350 };
const preparingProgress: Partial<Record<CardStage, number>> = { submitted: 34, approved: 67, issued: 90 };
const manWon = (value: number) => `${(value / 10_000).toLocaleString('ko-KR')}만원`;
const feeText = (plan: Plan) => PLANS[plan].annualFee ? `연 ${manWon(PLANS[plan].annualFee)}` : '무료';
const physicalName = physicalCardName;
const deliveryText: Record<Exclude<DeliveryStage, 'none'>, string> = { preparing: '만드는 중', shipped: '배송 중', delivered: '도착' };

/** Made, sent, arrived: a bar per step that fills as the card moves. */
function DeliverySteps({ delivery }: { delivery: DeliveryStage }) {
  return <ol className="cf-delivery-steps"><li className="cf-delivery-done">만드는 중</li><li className={delivery === 'shipped' || delivery === 'delivered' ? 'cf-delivery-done' : ''}>배송 중</li><li className={delivery === 'delivered' ? 'cf-delivery-done' : ''}>도착</li></ol>;
}

/** Facts joined by middle dots. Each fact wraps as a whole and carries the dot before it, so a dot never ends a line. */
function Facts({ items, className }: { items: ReactNode[]; className?: string }) {
  return <span className={`cf-facts${className ? ` ${className}` : ''}`}><span>{items.map((fact, index) => <span key={index}>{fact}</span>)}</span></span>;
}

/** One line per tier: what it gives. */
function TierFacts({ plan }: { plan: Plan }) {
  const terms = PLANS[plan];
  return <Facts className="cf-tier-facts" items={[`페이백 ${percent(terms.cashbackRate)}`, terms.reserveBonus ? `리저브 +${percent(terms.reserveBonus)}p` : terms.card]} />;
}

export default function CardApplication({ card, account, spend, controls, onOpenLimits, onOpenChannels, onPay, onChange, onAction, onDeposit, onNotify }: CardApplicationProps) {
  const [identityConsent, setIdentityConsent] = useState(false);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [walletSheet, setWalletSheet] = useState<MobileWallet | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [addressSheet, setAddressSheet] = useState<'select' | 'change' | 'physical' | null>(null);
  const [pendingAddress, setPendingAddress] = useState<ShippingAddress | null>(null);
  const [pinSheet, setPinSheet] = useState<'activate' | 'change' | 'replacement' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ card, onChange, onNotify });
  const plan = PLANS[card.plan];
  const applicationStep = stepByStage[card.stage];
  const selectingCard = card.stage === 'plan' || card.stage === 'details';
  const preparingCard = card.stage === 'submitted' || card.stage === 'approved' || card.stage === 'issued';
  const fee = cardApplicationFee(card);
  const shortfall = Math.max(0, fee - spend);

  useEffect(() => { latest.current = { card, onChange, onNotify }; }, [card, onChange, onNotify]);

  const stopTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => {
    const delay = autoDelays[card.stage];
    if (delay === undefined || toolsOpen) return;
    const expectedStage = card.stage;
    timer.current = setTimeout(() => {
      const current = latest.current;
      if (current.card.stage !== expectedStage) return;
      if (expectedStage === 'submitted') {
        current.onChange({ ...current.card, stage: 'approved' });
      } else if (expectedStage === 'approved') {
        current.onChange({ ...current.card, stage: 'issued', issuedAt: Date.now(), delivery: current.card.physical ? 'preparing' : 'none' });
      } else {
        current.onChange({ ...current.card, stage: 'active', locked: false });
        current.onNotify('카드가 나왔어요. 바로 쓸 수 있어요.');
      }
      timer.current = null;
    }, delay);
    return stopTimer;
  }, [card.stage, toolsOpen]);

  const patch = (change: Partial<CardState>) => onChange({ ...card, ...change });
  const nextStage = (stage: CardStage) => patch({ stage });
  // Premium and Private come with their metal card, so they always ship one.
  const choosePlan = (key: Plan) => patch({ plan: key, physical: key === 'standard' ? card.physical : true });

  const review = () => {
    setReviewConsent(false);
    // Both choices share one screen; keep the engine's ordered stages.
    const selected = { ...card, stage: 'details' as const };
    if (card.stage === 'plan') onChange(selected);
    onChange({ ...selected, stage: 'review' });
  };
  const backToIdentity = () => {
    if (card.stage === 'details') onChange({ ...card, stage: 'plan' });
    onChange({ ...card, stage: 'identity' });
  };
  const submit = () => {
    setToolsOpen(false);
    onAction({ type: 'SUBMIT_CARD' }, fee ? `${won(fee)}을 내고 신청했어요.` : '신청했어요.');
  };
  const restart = () => {
    stopTimer();
    setIdentityConsent(false);
    setReviewConsent(false);
    setRevealed(false);
    setToolsOpen(false);
    patch({ stage: 'identity', identityVerified: false, reference: '', submittedAt: null, issuedAt: null, delivery: 'none', physicalActive: false, locked: false });
  };
  const simulateResult = (stage: 'approved' | 'needs_info' | 'rejected') => {
    stopTimer();
    setToolsOpen(false);
    nextStage(stage);
  };

  const planSheet = (target: Plan) => {
    const terms = PLANS[target];
    const upgrade = PLAN_ORDER.indexOf(target) > PLAN_ORDER.indexOf(card.plan);
    const renewal = card.billingAt !== null ? dateLabel(card.billingAt) : '';
    return upgrade
      ? <CardActionSheet title={`${ro(terms.short)} 바꾸기`} lead="바꾸는 즉시 혜택이 적용돼요." spend={spend} cost={terms.annualFee} onDeposit={onDeposit} onClose={() => setSheet(null)}
        points={[`페이백이 ${percent(terms.cashbackRate)}로 올라요. 한 달 ${manWon(terms.spendCap)} 결제까지 받아요.`, `리저브 보상이 연 ${percent(terms.reserveBonus)}p 더 쌓여요. ${manWon(terms.reserveCap)}까지예요.`, `연회비 ${won(terms.annualFee)}을 지금 잔액에서 내고, 1년 뒤 같은 날 다시 내요.`, ...(plan.annualFee ? ['지금 멤버십의 남은 기간 연회비는 돌려드리지 않아요.'] : []), upgradePhysical(card, target).note.trim()]}
        confirmLabel={`${won(terms.annualFee)} 내고 바꾸기`} onConfirm={() => onAction({ type: 'CHANGE_PLAN', plan: target }, `${ro(terms.short)} 바꿨어요.`)} />
      : <CardActionSheet title={`${ro(terms.short)} 바꾸기`} spend={spend} onDeposit={onDeposit} onClose={() => setSheet(null)}
        points={[`${renewal}까지는 ${plan.short} 혜택을 그대로 써요.`, `그날부터 ${ro(terms.short)} 바뀌어요.${terms.annualFee ? ` ${terms.short} 연회비 ${won(terms.annualFee)}은 그날 나가요.` : ' 연회비는 더 나가지 않아요.'}`, '이미 낸 연회비는 돌려드리지 않아요.']}
        confirmLabel={`${renewal}에 바꾸기`} onConfirm={() => onAction({ type: 'CHANGE_PLAN', plan: target }, `${renewal}부터 ${ro(terms.short)} 바뀌어요.`)} />;
  };

  return (
    <section className="card-flow" aria-label="Aqua 카드">
      {applicationStep !== undefined && (
        <ol className="cf-steps" aria-label="카드 신청 단계">
          {steps.map((label, index) => <li key={label} className={index === applicationStep ? 'cf-step-current' : index < applicationStep ? 'cf-step-done' : ''} aria-current={index === applicationStep ? 'step' : undefined}><span>{index < applicationStep ? <Check size={12} strokeWidth={3} /> : index + 1}</span><strong>{label}</strong></li>)}
        </ol>
      )}

      {card.stage === 'not_applied' && <div className="cf-intro">
        <img className="cf-intro-art" src={heroCards} width={960} height={630} alt="" />
        <h2>잔액으로 바로 쓰는 카드</h2>
        <p className="cf-lead">가상카드는 신청하면 바로 나와요. 멤버십에 따라 페이백과 리저브 보상이 달라져요.</p>
        <ul className="cf-tiers" aria-label="멤버십">{PLAN_ORDER.map((key) => <li key={key}><TierCard plan={key} /><span className="cf-tier-main"><strong>{PLANS[key].short}</strong><TierFacts plan={key} /></span><span className="cf-tier-fee">{feeText(key)}</span></li>)}</ul>
        <button type="button" className="cf-button cf-primary" data-testid="card-apply" onClick={() => nextStage('identity')}>카드 만들기 <ArrowRight size={17} /></button>
        <p className="cf-disclaimer">체험판이라 실제 카드는 나오지 않아요.</p>
      </div>}

      {card.stage === 'identity' && <div className="cf-step">
        <h2>본인확인</h2><p className="cf-lead">가입할 때 확인한 정보로 신청해요. 다시 촬영하지 않아도 돼요.</p>
        <div className="cf-profile"><span className="cf-avatar" aria-hidden="true">{account.name.charAt(0)}</span><div><strong>{account.name}</strong><p><Facts items={[account.birthDate.replaceAll('-', '.'), maskPhone(account.phone)]} /></p></div><span className="cf-profile-status"><Check size={13} strokeWidth={2.6} />확인됨</span></div>
        <label className="cf-final-consent"><input type="checkbox" data-testid="card-identity-consent" checked={identityConsent} onChange={(event) => setIdentityConsent(event.target.checked)} /><span>본인확인 정보를 카드 발급사에 제공하는 데 동의해요.</span></label>
        <button type="button" className="cf-button cf-primary" data-testid="card-identity-next" disabled={!identityConsent} onClick={() => patch({ identityVerified: true, stage: 'plan' })}>다음 <ArrowRight size={17} /></button>
        <button type="button" className="cf-text-button" onClick={() => nextStage('not_applied')}><ChevronLeft size={15} /> 그만두기</button>
      </div>}

      {selectingCard && <div className="cf-step">
        <h2>멤버십 고르기</h2><p className="cf-lead">나중에 카드 화면에서 언제든 바꿀 수 있어요.</p>
        <fieldset className="cf-options"><legend className="cf-sr-only">멤버십</legend>{PLAN_ORDER.map((key) => { const option = PLANS[key]; return <label key={key} className={`cf-option ${card.plan === key ? 'cf-option-selected' : ''}`}><input type="radio" name="card-plan" value={key} checked={card.plan === key} onChange={() => choosePlan(key)} /><TierCard plan={key} /><span className="cf-option-main"><span className="cf-option-title">{option.short}</span><span className="cf-option-price">{feeText(key)}</span><TierFacts plan={key} /></span></label>; })}</fieldset>
        {card.plan === 'standard' ? <label className="cf-physical-option" data-testid="card-physical-row"><input type="checkbox" data-testid="card-physical-choice" checked={card.physical} onChange={(event) => patch({ physical: event.target.checked })} /><span><strong>실물카드도 받기</strong><small><Facts items={[PLANS.standard.physicalFee ? `발급비 ${won(PLANS.standard.physicalFee)}` : '무료', `배송 ${POLICY.deliveryEstimate}`]} /></small></span></label>
          : <p className="cf-included"><Package size={16} aria-hidden="true" /><span><span className="nowrap">{plan.card}가 함께 나와요.</span> <span className="nowrap">배송까지 {POLICY.deliveryEstimate}이 걸려요.</span></span></p>}
        {card.physical && <div className="cf-address" data-testid="card-address"><MapPin size={17} /><div>{card.address ? <><strong>{card.address.road}</strong><p><Facts items={[card.address.detail || '상세 주소 없음', card.address.zip]} /></p></> : <><strong>받을 주소를 넣어 주세요</strong><p>본인만 받을 수 있어요.</p></>}</div><button type="button" className="cf-address-button" data-testid="card-address-open" onClick={() => setAddressSheet('select')}>{card.address ? '변경' : '입력'}</button></div>}
        <button type="button" className="cf-button cf-primary" data-testid="card-selection-next" disabled={card.physical && !card.address} onClick={review}>다음 <ArrowRight size={17} /></button>
        <button type="button" className="cf-text-button" onClick={backToIdentity}><ChevronLeft size={15} /> 이전</button>
      </div>}

      {card.stage === 'review' && <div className="cf-step">
        <h2>신청 확인</h2>
        <dl className="cf-summary"><div><dt>신청하는 분</dt><dd>{account.name}</dd></div><div><dt>멤버십</dt><dd>{plan.name}</dd></div><div><dt>페이백</dt><dd>{percent(plan.cashbackRate)} · 월 {won(plan.cashbackCap)}까지</dd></div><div><dt>카드</dt><dd>{card.physical ? `가상카드와 ${physicalName(card.plan)}` : '가상카드'}</dd></div>{card.physical && card.address && <div><dt>받을 주소</dt><dd>{addressLine(card.address)}</dd></div>}</dl>
        <div className="cf-cost" data-testid="card-fee">
          <div className="cf-cost-head"><span>지금 낼 금액</span><strong data-testid="card-fee-total">{fee ? won(fee) : '없음'}</strong></div>
          {fee > 0 && <ul className="cf-cost-lines">{plan.annualFee > 0 && <li><span>{plan.short} 첫해 연회비</span><span>{won(plan.annualFee)}</span></li>}{card.physical && plan.physicalFee > 0 && <li><span>실물카드 발급비</span><span>{won(plan.physicalFee)}</span></li>}<li><span>지금 잔액</span><span>{won(spend)}</span></li></ul>}
          <p>{fee ? '잔액에서 내요. 승인되지 않으면 돌려드려요.' : card.physical ? '스탠다드는 가상카드와 실물카드 모두 비용이 없어요.' : '스탠다드 가상카드는 비용이 없어요.'}{plan.annualFee ? ' 연회비는 1년마다 같은 날 잔액에서 나가요.' : ''}</p>
        </div>
        {shortfall > 0 && <div className="cf-shortfall" role="alert" data-testid="card-fee-shortfall"><p>잔액이 {won(shortfall)} 모자라요. 충전한 뒤 신청해 주세요.</p><button type="button" className="cf-button cf-secondary" data-testid="card-fee-deposit" onClick={onDeposit}>충전하기</button></div>}
        <label className="cf-final-consent"><input type="checkbox" data-testid="card-review-consent" checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} /><span>{fee ? '멤버십과 낼 금액을 확인했어요.' : '멤버십과 신청 내용을 확인했어요.'}</span></label>
        <button type="button" className="cf-button cf-primary" data-testid="card-submit" disabled={!reviewConsent || shortfall > 0} onClick={submit}>{fee ? `${won(fee)} 내고 신청하기` : '신청하기'} <ArrowRight size={17} /></button>
        <button type="button" className="cf-text-button" onClick={() => nextStage('details')}><ChevronLeft size={15} /> 이전</button>
      </div>}

      {preparingCard && <div className="cf-step" aria-live="polite" data-testid="card-preparing">
        <div className="cf-status-head"><span className="cf-status-icon"><Clock3 /></span><div><h2>카드를 만들고 있어요</h2><p>{card.stage === 'submitted' ? '신청 내용을 확인하고 있어요.' : card.stage === 'approved' ? '가상카드를 발급하고 있어요.' : '카드를 쓸 수 있게 준비하고 있어요.'}</p></div></div>
        <div className="cf-progress" aria-hidden="true"><span style={{ width: `${preparingProgress[card.stage] ?? 0}%` }} /></div>
        <div className="cf-reference"><span>접수번호</span><strong>{card.reference}</strong></div>
        <p className="cf-disclaimer">체험판이라 잠시 뒤 자동으로 끝나요.</p>
      </div>}

      {card.stage === 'needs_info' && <div className="cf-step">
        <div className="cf-status-head cf-status-warning"><span className="cf-status-icon"><CircleAlert /></span><div><h2>본인확인을 한 번 더 해 주세요</h2><p>발급사가 본인확인 정보를 다시 확인해 달라고 했어요. 낸 비용은 돌려드렸고, 다시 신청할 때 내면 돼요.</p></div></div>
        <div className="cf-reference"><span>접수번호</span><strong>{card.reference}</strong></div>
        <button type="button" className="cf-button cf-primary" data-testid="card-resubmit" onClick={() => { setIdentityConsent(false); setReviewConsent(false); setToolsOpen(false); patch({ stage: 'identity', identityVerified: false }); }}>다시 확인하기 <ArrowRight size={17} /></button>
      </div>}

      {card.stage === 'rejected' && <div className="cf-step">
        <div className="cf-status-head cf-status-danger"><span className="cf-status-icon"><CircleAlert /></span><div><h2>신청이 승인되지 않았어요</h2><p>신청할 때 낸 비용은 잔액으로 돌려드렸어요.</p></div></div>
        <button type="button" className="cf-button cf-primary" data-testid="card-restart" onClick={restart}>다시 신청하기 <RefreshCw size={17} /></button>
      </div>}

      {card.stage === 'active' && <div className="cf-active">
        <div className="cf-hero"><CardVisual card={card} variant="hero" revealed={revealed} /></div>
        <div className="cf-hero-caption"><strong>{plan.name}</strong><span className={card.locked ? 'cf-locked' : ''} data-testid="card-status">{card.locked ? <><LockKeyhole size={13} aria-hidden="true" />잠금</> : '사용 중'}</span></div>
        <div className="cf-quick">
          <button type="button" className="cf-quick-button" data-testid="card-details-toggle" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}><span>{revealed ? <EyeOff /> : <Eye />}</span>{revealed ? '정보 숨기기' : '카드 정보'}</button>
          <button type="button" className={`cf-quick-button${card.locked ? ' cf-quick-warning' : ''}`} data-testid="card-lock-toggle" aria-pressed={card.locked} onClick={() => { patch({ locked: !card.locked }); onNotify(card.locked ? '잠금을 풀었어요.' : '카드를 잠갔어요. 새 결제는 모두 거절돼요.'); }}><span>{card.locked ? <UnlockKeyhole /> : <LockKeyhole />}</span>{card.locked ? '잠금 풀기' : '잠그기'}</button>
          <button type="button" className="cf-quick-button" data-testid="card-pay" disabled={card.locked} onClick={onPay}><span><CreditCard /></span>결제해 보기</button>
        </div>
        {revealed && <div className="cf-demo-details"><span className="cf-simulation-label">체험용 카드 정보예요. 실제로 결제되지 않아요.</span><dl><div><dt>카드번호</dt><dd>4242 4242 4242 {card.last4}</dd></div><div><dt>유효기간</dt><dd>12/30</dd></div><div><dt>CVC</dt><dd>123</dd></div></dl></div>}
        {card.locked && <div className="cf-info-box cf-warning-box"><LockKeyhole size={18} /><p>잠근 동안 새 결제는 거절돼요. 이미 한 결제의 취소와&nbsp;환불은 그대로 돼요.</p></div>}

        <section className="cf-section" aria-labelledby="cf-wallets-title">
          <h3 id="cf-wallets-title">휴대폰 결제</h3>
          <ul className="cf-wallets">{(Object.keys(WALLET_NAMES) as MobileWallet[]).map((wallet) => {
            const added = card.wallets.includes(wallet);
            return <li key={wallet}><span className="cf-wallet-icon" aria-hidden="true"><Smartphone /></span><div><strong>{WALLET_NAMES[wallet]}</strong><p>{added ? `끝번호 ${card.last4} 카드가 들어 있어요` : '휴대폰을 단말기에 대서 결제해요'}</p></div>{added ? <span className="cf-wallet-added" data-testid={`wallet-added-${wallet}`}><Check size={14} strokeWidth={2.6} />추가됨</span> : <button type="button" className="cf-button cf-secondary cf-wallet-add" data-testid={`wallet-add-${wallet}`} disabled={card.locked} onClick={() => setWalletSheet(wallet)}>추가</button>}</li>;
          })}</ul>
          {card.locked && <p className="cf-wallet-note">잠금을 풀면 추가할 수 있어요.</p>}
        </section>

        <section className="cf-section" data-testid="card-plan" aria-labelledby="cf-plan-title">
          <h3 id="cf-plan-title">멤버십</h3>
          <Facts className="cf-plan-now" items={[<strong>{plan.short}</strong>, `페이백 ${percent(plan.cashbackRate)}`, `월 ${won(plan.cashbackCap)}까지`, ...(plan.reserveBonus ? [`리저브 +${percent(plan.reserveBonus)}p`] : [])]} />
          {card.billingAt !== null && <p className="cf-plan-renewal"><CalendarClock size={15} aria-hidden="true" />{card.nextPlan ? `${dateLabel(card.billingAt)}부터 ${ro(PLANS[card.nextPlan].short)} 바뀌어요` : <>다음 갱신일 <span data-testid="card-billing-date">{dateLabel(card.billingAt)}</span></>}</p>}
          <ul className="cf-plan-list">{PLAN_ORDER.map((key) => {
            const current = key === card.plan;
            const scheduled = card.nextPlan === key;
            return <li key={key} className={current ? 'cf-plan-current' : ''}><TierCard plan={key} /><span className="cf-tier-main"><strong>{PLANS[key].short}</strong><Facts items={[feeText(key), `페이백 ${percent(PLANS[key].cashbackRate)}`]} /></span>
              {current ? card.nextPlan ? <button type="button" className="cf-plan-action" data-testid="card-plan-keep" onClick={() => onAction({ type: 'CHANGE_PLAN', plan: key }, `${josa(PLANS[key].short, '을', '를')} 계속 써요.`)}>계속 쓰기</button> : <span className="cf-plan-tag">사용 중</span>
                : scheduled ? <span className="cf-plan-tag scheduled">예약됨</span>
                  : <button type="button" className="cf-plan-action" data-testid={`card-plan-${key}`} onClick={() => setSheet({ kind: 'plan', plan: key })}>바꾸기</button>}</li>;
          })}</ul>
        </section>

        <section className="cf-section" aria-labelledby="cf-settings-title">
          <h3 id="cf-settings-title">카드 설정</h3>
          <NavRow label="결제 한도" value={`1회 ${manWon(controls.perPayment)}`} testId="card-open-limits" onClick={onOpenLimits} />
          <NavRow label="온라인·해외 결제" value={controls.online && controls.overseas ? '모두 허용' : !controls.online && !controls.overseas ? '모두 막음' : controls.online ? '해외 막음' : '온라인 막음'} testId="card-open-channels" onClick={onOpenChannels} />
          {!card.physical && <NavRow label={`${physicalName(card.plan)} 받기`} value={plan.physicalFee ? won(plan.physicalFee) : '무료'} testId="card-physical-add" onClick={() => setAddressSheet('physical')} />}
          {card.physical && <div className="cf-delivery">
            <div className="cf-delivery-heading"><Package size={18} aria-hidden="true" /><strong data-testid="card-physical-name">{physicalName(card.physicalPlan ?? card.plan)}</strong><span>{card.physicalActive ? '쓰는 중' : card.delivery === 'none' ? '' : deliveryText[card.delivery]}</span></div>
            {!card.physicalActive && <DeliverySteps delivery={card.delivery} />}
            {card.address && !card.physicalActive && <p className="cf-delivery-address"><MapPin size={14} /><span>{addressLine(card.address)}</span>{card.delivery === 'preparing' && <button type="button" className="cf-inline-link" data-testid="card-address-change" onClick={() => setAddressSheet('change')}>변경</button>}</p>}
            {card.delivery === 'delivered' && !card.physicalActive && <button type="button" className="cf-button cf-primary" data-testid="card-physical-activate" onClick={() => setPinSheet('activate')}>받은 카드 쓰기 시작 <ArrowRight size={16} /></button>}
            {card.physicalActive && <button type="button" className="cf-inline-link cf-pin-link" data-testid="card-pin-change" onClick={() => setPinSheet('change')}>카드 비밀번호 바꾸기</button>}
          </div>}
          {card.replacement && <div className="cf-delivery cf-replacement" data-testid="card-replacement">
            <div className="cf-delivery-heading"><TierCard plan={card.replacement.plan} className="cf-replacement-thumb" /><strong>새 {physicalName(card.replacement.plan)}</strong><span data-testid="card-replacement-status">{deliveryText[card.replacement.delivery]}</span></div>
            <DeliverySteps delivery={card.replacement.delivery} />
            {card.address && <p className="cf-delivery-address"><MapPin size={14} /><span>{addressLine(card.address)}</span>{card.replacement.delivery === 'preparing' && <button type="button" className="cf-inline-link" data-testid="card-replacement-address" onClick={() => setAddressSheet('change')}>변경</button>}</p>}
            <p className="cf-replacement-note">받을 때까지 지금 카드를 그대로 써요. 카드 번호는 바뀌지 않아요.</p>
            {card.replacement.delivery === 'delivered' && <button type="button" className="cf-button cf-primary" data-testid="card-replacement-activate" onClick={() => card.pinSet ? setSheet({ kind: 'replacement' }) : setPinSheet('replacement')}>새 카드 쓰기 시작 <ArrowRight size={16} /></button>}
          </div>}
          <NavRow label="분실·도난 신고" detail="지금 카드를 막고 새 번호로 다시 받아요" testId="card-reissue" onClick={() => setSheet({ kind: 'reissue' })} />
          <NavRow label="카드 해지" testId="card-close" danger onClick={() => setSheet({ kind: 'close' })} />
        </section>

        {walletSheet && <WalletSheet wallet={walletSheet} card={card} phone={account.phone} onClose={() => setWalletSheet(null)} onAdd={() => patch({ wallets: [...card.wallets, walletSheet] })} />}
        {sheet?.kind === 'plan' && planSheet(sheet.plan)}
        {sheet?.kind === 'physical' && pendingAddress && <CardActionSheet title={`${physicalName(card.plan)} 받기`} lead="가게 단말기에 꽂거나 대서 결제하는 카드예요." spend={spend} cost={plan.physicalFee || undefined} onDeposit={onDeposit} onClose={() => setSheet(null)}
          points={['가상카드와 같은 잔액으로 결제해요.', `${addressLine(pendingAddress)}로 보내 드려요. ${POLICY.deliveryEstimate}이 걸려요.`, '받은 뒤 앱에서 카드 비밀번호를 정하면 쓸 수 있어요.']}
          confirmLabel={plan.physicalFee ? `${won(plan.physicalFee)} 내고 신청` : '신청하기'} onConfirm={() => onAction({ type: 'ADD_PHYSICAL_CARD', address: pendingAddress }, `${josa(physicalName(card.plan), '을', '를')} 신청했어요.`)} />}
        {sheet?.kind === 'replacement' && card.replacement && <CardActionSheet title={`새 ${physicalName(card.replacement.plan)} 쓰기 시작`} spend={spend} onDeposit={onDeposit} onClose={() => setSheet(null)}
          points={['카드 번호와 카드 비밀번호는 그대로예요.', '지금 쓰던 실물카드는 바로 결제가 막혀요. 잘라서 버려 주세요.', '가상카드와 휴대폰 결제는 그대로 써요.']}
          confirmLabel="쓰기 시작" onConfirm={() => onAction({ type: 'ACTIVATE_REPLACEMENT' }, `새 ${ro(physicalName(card.replacement!.plan))} 결제할 수 있어요.`)} />}
        {sheet?.kind === 'reissue' && <CardActionSheet title="분실·도난 신고" lead="지금 카드를 바로 막고 새 번호로 다시 발급해요." spend={spend} cost={card.physical && plan.physicalFee ? plan.physicalFee : undefined} onDeposit={onDeposit} onClose={() => setSheet(null)}
          points={[`끝번호 ${card.last4} 카드는 바로 결제가 막혀요.`, '가상카드는 새 번호로 바로 나와요.', ...(card.wallets.length ? ['휴대폰 결제에 넣은 카드는 지워져요. 새 카드로 다시 추가해 주세요.'] : []), ...(card.physical ? [`${physicalName(card.plan)}는 ${card.address ? ro(addressLine(card.address)) : '등록한 주소로'} 새로 보내 드려요.${plan.physicalFee ? ` 재발급비 ${won(plan.physicalFee)}이 들어요.` : ''}`] : []), ...(card.replacement ? [`보내고 있는 ${physicalName(card.replacement.plan)}도 막혀요.`] : [])]}
          confirmLabel={card.physical && plan.physicalFee ? `${won(plan.physicalFee)} 내고 재발급` : '신고하고 재발급'} onConfirm={() => { const done = onAction({ type: 'REISSUE_CARD' }, '새 카드를 발급했어요.'); if (done) setRevealed(false); return done; }} />}
        {sheet?.kind === 'close' && <CardActionSheet title="카드 해지" lead="해지한 카드는 다시 쓸 수 없어요." spend={spend} onDeposit={onDeposit} onClose={() => setSheet(null)} danger consent="위 내용을 확인했어요."
          points={['카드 번호와 휴대폰 결제가 바로 멈춰요.', '잔액과 리저브는 그대로 남아요.', '리워드는 카드를 다시 만들면 쓸 수 있어요.', ...(plan.annualFee ? [`${plan.short} 멤버십도 끝나요. 이미 낸 연회비는 돌려드리지 않아요.`] : []), '확정 전 결제와 환불은 그대로 처리돼요.']}
          confirmLabel="카드 해지" onConfirm={() => { const done = onAction({ type: 'CLOSE_CARD' }, '카드를 해지했어요.'); if (done) setRevealed(false); return done; }} />}
      </div>}

      {pinSheet && <PinSheet mode={pinSheet === 'change' ? 'change' : 'activate'} onClose={() => setPinSheet(null)} onSubmit={(pin) => pinSheet === 'replacement'
        ? onAction({ type: 'ACTIVATE_REPLACEMENT', pin }, card.replacement ? `새 ${ro(physicalName(card.replacement.plan))} 결제할 수 있어요.` : '새 카드로 결제할 수 있어요.')
        : onAction(pinSheet === 'activate' ? { type: 'ACTIVATE_PHYSICAL', pin } : { type: 'SET_CARD_PIN', pin }, pinSheet === 'activate' ? '실물카드를 쓸 수 있어요.' : '카드 비밀번호를 바꿨어요.')} />}
      {addressSheet && <AddressSheet initial={addressSheet === 'physical' ? pendingAddress : card.address} holder={account.name} confirmLabel={addressSheet === 'physical' ? '다음' : '이 주소로 받기'} onClose={() => setAddressSheet(null)}
        onSave={(address) => {
          setAddressSheet(null);
          if (addressSheet === 'physical') { setPendingAddress(address); setSheet({ kind: 'physical' }); return; }
          patch({ address });
          if (addressSheet === 'change') onNotify('받을 주소를 바꿨어요.');
        }} />}

      {(card.stage === 'submitted' || card.stage === 'active') && <details className="cf-demo-tools" data-testid="card-demo-tools" open={toolsOpen} onToggle={(event) => { stopTimer(); setToolsOpen(event.currentTarget.open); }}><summary>체험 도구</summary>
        {card.stage === 'submitted' && <div className="cf-simulation"><p>도구를 닫으면 심사가 자동으로 진행돼요.</p><button type="button" className="cf-button cf-secondary" data-testid="card-demo-approve" onClick={() => simulateResult('approved')}>승인하기</button><div className="cf-button-row"><button type="button" className="cf-button cf-secondary" data-testid="card-demo-needs-info" onClick={() => simulateResult('needs_info')}>보완 요청</button><button type="button" className="cf-button cf-secondary" data-testid="card-demo-reject" onClick={() => simulateResult('rejected')}>거절하기</button></div></div>}
        {card.stage === 'active' && <div className="cf-simulation cf-demo-list">
          {card.billingAt !== null && <button type="button" className="cf-button cf-secondary" data-testid="card-demo-billing" onClick={() => onAction({ type: 'ADVANCE_TO_BILLING' }, '갱신일로 시간을 옮겼어요.')}><CalendarClock size={16} /> 갱신일({dateLabel(card.billingAt)})로 이동</button>}
          {card.physical && card.delivery === 'preparing' && <button type="button" className="cf-button cf-secondary" data-testid="card-demo-shipped" onClick={() => patch({ delivery: 'shipped' })}><Truck size={16} /> 배송 시작</button>}
          {card.physical && card.delivery === 'shipped' && <button type="button" className="cf-button cf-secondary" data-testid="card-demo-delivered" onClick={() => patch({ delivery: 'delivered' })}><Package size={16} /> 배송 완료</button>}
          {card.replacement && card.replacement.delivery !== 'delivered' && <button type="button" className="cf-button cf-secondary" data-testid="card-demo-replacement" onClick={() => onAction({ type: 'ADVANCE_REPLACEMENT' }, card.replacement?.delivery === 'preparing' ? '새 카드를 보냈어요.' : '새 카드가 도착했어요.')}>{card.replacement.delivery === 'preparing' ? <><Truck size={16} /> 새 카드 배송 시작</> : <><Package size={16} /> 새 카드 배송 완료</>}</button>}
          {card.billingAt === null && (!card.physical || card.delivery === 'delivered') && !card.replacement && <p>지금은 해&nbsp;볼 단계가 없어요. 프리미엄으로 바꾸면 갱신일 이동을 해&nbsp;볼&nbsp;수 있어요.</p>}
        </div>}
      </details>}
    </section>
  );
}
