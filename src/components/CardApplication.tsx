import { useState } from 'react';
import {
  ArrowRight, Check, ChevronLeft, CircleAlert, CircleCheck, Clock3,
  CreditCard, Eye, EyeOff, Fingerprint, LockKeyhole, MapPin, Package,
  RefreshCw, ShieldCheck, Sparkles, Truck, UnlockKeyhole,
} from 'lucide-react';
import { PLANS, POLICY } from '../lib/policy';
import type { CardStage, CardState, Plan } from '../lib/types';
import './CardApplication.css';

interface CardApplicationProps {
  card: CardState;
  onChange: (next: CardState) => void;
  onNotify: (message: string) => void;
}

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
const steps = ['본인확인', '플랜 선택', '카드 선택', '신청 확인', '발급'];
const stepByStage: Record<CardStage, number> = {
  not_applied: 0, identity: 0, plan: 1, details: 2, review: 3,
  submitted: 4, needs_info: 4, approved: 4, issued: 4, active: 4, rejected: 4,
};

function CardPreview({ card, revealed = false }: { card: CardState; revealed?: boolean }) {
  return (
    <div className={`cf-card-art ${card.plan === 'plus' ? 'cf-card-art-plus' : ''}`} aria-label={`Aqua ${card.plan === 'plus' ? 'Plus' : 'Basic'} 모의 카드`}>
      <div className="cf-card-art-top"><span className="cf-wordmark">aqua<span /></span><span className="cf-card-art-label">{card.plan === 'plus' ? 'PLUS' : 'BASIC'}</span></div>
      <div className="cf-chip"><span /><span /><span /></div>
      <div className="cf-card-art-number">{revealed ? '4242 4242 4242 2048' : `••••  ••••  ••••  ${card.last4 || '2048'}`}</div>
      <div className="cf-card-art-bottom"><div><span>DEMO MEMBER</span><strong>AQUA MEMBER</strong></div><span className="cf-card-art-demo">DEMO</span></div>
    </div>
  );
}

export default function CardApplication({ card, onChange, onNotify }: CardApplicationProps) {
  const [identityConsent, setIdentityConsent] = useState(false);
  const [termsConsent, setTermsConsent] = useState(false);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const plan = PLANS[card.plan];
  const isApplication = ['identity', 'plan', 'details', 'review'].includes(card.stage);
  const patch = (change: Partial<CardState>) => onChange({ ...card, ...change });
  const nextStage = (stage: CardStage) => patch({ stage });

  const submit = () => {
    patch({
      stage: 'submitted',
      reference: card.reference || `AQ-DEMO-${String(Date.now()).slice(-8)}`,
      submittedAt: Date.now(),
    });
    onNotify('데모 카드 신청이 접수되었습니다. 심사 결과를 직접 시뮬레이션할 수 있어요.');
  };

  const restart = () => {
    setIdentityConsent(false);
    setTermsConsent(false);
    setReviewConsent(false);
    setRevealed(false);
    patch({ stage: 'identity', identityVerified: false, reference: '', submittedAt: null, issuedAt: null, delivery: 'none', physicalActive: false, locked: false });
  };

  const statusPanel = (icon: typeof Clock3, title: string, text: string) => {
    const Icon = icon;
    return <div className="cf-status-head"><span className="cf-status-icon"><Icon size={26} /></span><div><p className="cf-kicker">APPLICATION STATUS</p><h2>{title}</h2><p>{text}</p></div></div>;
  };

  return (
    <section className="card-flow" aria-label="Aqua 카드 신청 및 관리">
      <div className="cf-page-heading"><div><p className="cf-kicker">YOUR EVERYDAY CARD</p><h1>일상에 흐르는 Aqua.</h1><p>자산에서 결제까지, 하나의 카드로.</p></div><span className="cf-demo-badge"><ShieldCheck size={14} /> 발급 시뮬레이션</span></div>

      {isApplication && (
        <ol className="cf-steps" aria-label="카드 신청 단계">
          {steps.map((label, index) => <li key={label} className={index === stepByStage[card.stage] ? 'cf-step-current' : index < stepByStage[card.stage] ? 'cf-step-done' : ''} aria-current={index === stepByStage[card.stage] ? 'step' : undefined}><span>{index < stepByStage[card.stage] ? <Check size={14} /> : index + 1}</span><strong>{label}</strong></li>)}
        </ol>
      )}

      <div className="cf-layout">
        <aside className="cf-showcase">
          <div className="cf-preview-background"><span className="cf-preview-orbit cf-preview-orbit-one" /><span className="cf-preview-orbit cf-preview-orbit-two" /><CardPreview card={card} revealed={revealed && card.stage === 'active'} /></div>
          <div className="cf-showcase-copy"><span className="cf-small-badge">{plan.name}</span><h2>가지고 있던 자산이,<br />오늘의 결제로.</h2><p>결제할 때 페이백을 받고,<br />Reserve에서는 리워드를 쌓으세요.</p></div>
          <div className="cf-benefit-grid">
            <div><span>결제 페이백</span><strong>{(plan.cashbackRate * 100).toLocaleString('ko-KR')}<small>%</small></strong><p>월 최대 {won(plan.cashbackCap)}</p></div>
            <div><span>플랜 이용료</span><strong>{card.plan === 'basic' ? '무료' : '4,900'}{card.plan === 'plus' && <small>원</small>}</strong><p>{card.plan === 'basic' ? '가상카드 발급 포함' : '매월 · 데모 청구 없음'}</p></div>
          </div>
          <div className="cf-quiet-note"><ShieldCheck size={16} /><span>가상카드부터 시작하고, 실물카드도 함께 신청할 수 있어요.</span></div>
        </aside>

        <div className="cf-panel">
          {card.stage === 'not_applied' && <>
            <span className="cf-round-icon"><CreditCard size={25} /></span><p className="cf-kicker">MEET AQUA CARD</p><h2>첫 Aqua 카드를 만나보세요.</h2><p className="cf-panel-description">신청부터 발급, 활성화까지.<br />샘플 프로필로 전체 경험을 살펴보세요.</p>
            <div className="cf-feature-list"><div><Fingerprint size={19} /><span><strong>간편한 신청</strong><small>본인확인 → 플랜 → 카드 선택</small></span></div><div><Sparkles size={19} /><span><strong>카드 사용으로 쌓이는 리워드</strong><small>결제 확정 후 Aqua Rewards로 페이백</small></span></div><div><CreditCard size={19} /><span><strong>가상카드와 실물카드</strong><small>가상카드 무료 · 실물 발급비 {won(POLICY.physicalIssueFee)}</small></span></div></div>
            <button className="cf-button cf-primary" onClick={() => nextStage('identity')}>카드 신청하기 <ArrowRight size={17} /></button>
            <p className="cf-disclaimer">이 PoC는 실제 카드를 발급하거나 개인정보를 수집하지 않습니다.</p>
          </>}

          {card.stage === 'identity' && <>
            <p className="cf-kicker">STEP 01 / IDENTITY</p><h2>먼저, 본인확인부터.</h2><p className="cf-panel-description">실제 입력 없이 샘플 프로필로 진행합니다.</p>
            <div className="cf-profile"><span className="cf-avatar">A</span><div><strong>아쿠아 사용자</strong><p>대한민국 · 성인 · 샘플 프로필</p></div><span className="cf-profile-status">DEMO</span></div>
            <div className="cf-info-box"><ShieldCheck size={18} /><p>실제 출시 시에는 제휴 본인확인 서비스와 카드 대행사를 통해 고객 확인 및 적격성 심사를 진행합니다.</p></div>
            <div className="cf-consents"><label><input type="checkbox" checked={identityConsent} onChange={(event) => setIdentityConsent(event.target.checked)} /><span>샘플 프로필로 본인확인 진행에 동의합니다.<small>필수 · 실제 신분증, 전화번호를 입력하지 않습니다.</small></span></label><label><input type="checkbox" checked={termsConsent} onChange={(event) => setTermsConsent(event.target.checked)} /><span>데모 이용약관과 개인정보 안내를 확인했습니다.<small>필수 · 실제 서비스 가입 동의가 아닙니다.</small></span></label></div>
            <details className="cf-terms"><summary>데모 이용 안내 보기</summary><p>실제 자금 이동, 카드 발급, 금융 수익 지급은 발생하지 않습니다. 상태와 거래 내역은 브라우저에 저장되며 데모 초기화로 삭제할 수 있습니다. 실제 출시 시 별도 이용약관, 개인정보 처리방침, 본인확인 및 카드사 약관을 확정합니다.</p></details>
            <button className="cf-button cf-primary" disabled={!identityConsent || !termsConsent} onClick={() => { patch({ identityVerified: true, stage: 'plan' }); onNotify('샘플 본인확인이 완료되었습니다.'); }}>본인확인 완료 · 다음 <ArrowRight size={17} /></button>
            <button className="cf-text-button" onClick={() => nextStage('not_applied')}><ChevronLeft size={15} /> 돌아가기</button>
          </>}

          {card.stage === 'plan' && <>
            <p className="cf-kicker">STEP 02 / YOUR PLAN</p><h2>나에게 맞는 플랜.</h2><p className="cf-panel-description">사용 패턴에 맞춰 혜택을 선택하세요.</p>
            <fieldset className="cf-options"><legend className="cf-sr-only">카드 플랜 선택</legend>{(['basic', 'plus'] as Plan[]).map((key) => { const option = PLANS[key]; return <label key={key} className={`cf-option ${card.plan === key ? 'cf-option-selected' : ''}`}><input type="radio" name="card-plan" value={key} checked={card.plan === key} onChange={() => patch({ plan: key })} /><span className="cf-option-main"><span className="cf-option-title">{option.name}{key === 'plus' && <span className="cf-tag">MORE REWARDS</span>}</span><span className="cf-option-price">{option.monthlyFee === 0 ? '월 이용료 무료' : `월 ${won(option.monthlyFee)}`}</span><span className="cf-option-detail">페이백 {option.cashbackRate * 100}% · 월 최대 {won(option.cashbackCap)}</span></span><span className="cf-selection-mark">{card.plan === key && <Check size={13} />}</span></label>; })}</fieldset>
            <div className="cf-info-box"><CircleAlert size={18} /><p>Reserve 리워드는 두 플랜 모두 동일합니다. 페이백은 결제 확정 후 지급되며, 취소·환불 시 조정됩니다.</p></div>
            <button className="cf-button cf-primary" onClick={() => nextStage('details')}>플랜 선택 완료 <ArrowRight size={17} /></button><button className="cf-text-button" onClick={() => nextStage('identity')}><ChevronLeft size={15} /> 이전 단계</button>
          </>}

          {card.stage === 'details' && <>
            <p className="cf-kicker">STEP 03 / CARD TYPE</p><h2>어떤 카드로 시작할까요?</h2><p className="cf-panel-description">가상카드는 기본으로 발급됩니다.</p>
            <fieldset className="cf-options"><legend className="cf-sr-only">카드 종류 선택</legend><label className={`cf-option ${!card.physical ? 'cf-option-selected' : ''}`}><input type="radio" name="card-type" checked={!card.physical} onChange={() => patch({ physical: false })} /><CreditCard size={22} /><span className="cf-option-main"><span className="cf-option-title">가상카드</span><span className="cf-option-detail">발급비 무료 · 앱에서 관리</span></span><span className="cf-selection-mark">{!card.physical && <Check size={13} />}</span></label><label className={`cf-option ${card.physical ? 'cf-option-selected' : ''}`}><input type="radio" name="card-type" checked={card.physical} onChange={() => patch({ physical: true })} /><Package size={22} /><span className="cf-option-main"><span className="cf-option-title">가상카드 + 실물카드</span><span className="cf-option-detail">발급비 {won(POLICY.physicalIssueFee)} · 배송 {POLICY.deliveryEstimate}</span></span><span className="cf-selection-mark">{card.physical && <Check size={13} />}</span></label></fieldset>
            {card.physical && <div className="cf-address"><MapPin size={19} /><div><strong>샘플 배송지</strong><p>서울특별시 아쿠아로 1, 데모동 101호</p><small>존재하지 않는 데모 주소입니다. 실제 배송은 진행되지 않습니다.</small></div></div>}
            <p className="cf-disclaimer">월 이용료와 발급비는 PoC에서 실제 청구하지 않습니다.</p>
            <button className="cf-button cf-primary" onClick={() => { setReviewConsent(false); nextStage('review'); }}>신청 내용 확인 <ArrowRight size={17} /></button><button className="cf-text-button" onClick={() => nextStage('plan')}><ChevronLeft size={15} /> 이전 단계</button>
          </>}

          {card.stage === 'review' && <>
            <p className="cf-kicker">STEP 04 / REVIEW</p><h2>마지막으로 확인해 주세요.</h2><p className="cf-panel-description">신청을 접수하면 대행사 심사 단계로 넘어갑니다.</p>
            <dl className="cf-summary"><div><dt>신청자</dt><dd>아쿠아 사용자 <span className="cf-inline-demo">샘플</span></dd></div><div><dt>플랜</dt><dd>{plan.name}</dd></div><div><dt>월 이용료</dt><dd>{plan.monthlyFee === 0 ? '무료' : won(plan.monthlyFee)}</dd></div><div><dt>결제 페이백</dt><dd>{plan.cashbackRate * 100}% · 월 최대 {won(plan.cashbackCap)}</dd></div><div><dt>카드 종류</dt><dd>{card.physical ? '가상카드 + 실물카드' : '가상카드'}</dd></div><div><dt>일회성 발급비</dt><dd>{card.physical ? won(POLICY.physicalIssueFee) : '무료'}</dd></div>{card.physical && <div><dt>배송 예상</dt><dd>{POLICY.deliveryEstimate}</dd></div>}</dl>
            <div className="cf-info-box"><ShieldCheck size={18} /><p>카드 대행사 제휴, 국내 이용 조건과 지급률은 실제 출시 전 확정이 필요합니다. 지금은 모든 단계를 데모로 진행합니다.</p></div>
            <label className="cf-final-consent"><input type="checkbox" checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} /><span>선택한 플랜·발급비·이용 제한을 확인했습니다.</span></label>
            <button className="cf-button cf-primary" disabled={!reviewConsent} onClick={submit}>카드 신청 접수 <ArrowRight size={17} /></button><button className="cf-text-button" onClick={() => nextStage('details')}><ChevronLeft size={15} /> 이전 단계</button>
          </>}

          {card.stage === 'submitted' && <>
            {statusPanel(Clock3, '신청이 접수되었어요.', '카드 대행사에서 신청 내용을 확인하는 단계입니다.')}
            <div className="cf-reference"><span>데모 접수번호</span><strong>{card.reference}</strong></div><div className="cf-progress-line"><span className="cf-line-done"><Check size={14} /> 본인확인</span><span className="cf-line-current">심사 중</span><span>발급 대기</span></div>
            <div className="cf-simulation"><span className="cf-simulation-label">심사 결과 시뮬레이션</span><p>실제 대행사 요청 없이 다음 상태를 체험하세요.</p><button className="cf-button cf-primary" onClick={() => { nextStage('approved'); onNotify('데모 심사가 승인되었습니다.'); }}>데모 심사 통과 <Check size={17} /></button><div className="cf-button-row"><button className="cf-button cf-secondary" onClick={() => { nextStage('needs_info'); onNotify('데모 보완 요청 상태로 변경했습니다.'); }}>데모 보완 요청</button><button className="cf-button cf-secondary" onClick={() => { nextStage('rejected'); onNotify('데모 심사 거절 상태로 변경했습니다.'); }}>데모 심사 거절</button></div></div>
          </>}

          {card.stage === 'needs_info' && <>
            {statusPanel(CircleAlert, '조금 더 확인이 필요해요.', '샘플 프로필 정보를 다시 확인한 뒤 재제출해 주세요.')}
            <div className="cf-info-box"><Fingerprint size={18} /><p>데모 보완 사유: 본인확인 결과 재검증. 실제 서비스에서는 필요한 항목, 제출 기한과 문의 경로를 함께 안내합니다.</p></div><div className="cf-reference"><span>데모 접수번호</span><strong>{card.reference}</strong></div>
            <button className="cf-button cf-primary" onClick={() => { setIdentityConsent(false); setTermsConsent(false); setReviewConsent(false); patch({ stage: 'identity', identityVerified: false }); }}>샘플 정보 확인 후 재제출 <ArrowRight size={17} /></button>
          </>}

          {card.stage === 'rejected' && <>
            {statusPanel(CircleAlert, '이번 신청은 승인되지 않았어요.', '이 화면은 카드 심사 거절 상황을 보여주는 데모입니다.')}
            <div className="cf-info-box"><ShieldCheck size={18} /><p>심사 거절 시 카드가 발급되지 않으며 기존 지갑 자산은 그대로 유지됩니다. 실제 사유와 재신청 조건은 대행사 정책에 따라 안내합니다.</p></div><div className="cf-reference"><span>데모 접수번호</span><strong>{card.reference}</strong></div>
            <button className="cf-button cf-primary" onClick={restart}>신청 다시 시작 <RefreshCw size={17} /></button>
          </>}

          {card.stage === 'approved' && <>
            {statusPanel(CircleCheck, '심사가 승인되었어요.', '이제 가상카드를 발급하고 활성화할 수 있습니다.')}
            <div className="cf-approved-details"><div><ShieldCheck size={17} /><span>본인확인 완료</span><Check size={15} /></div><div><CreditCard size={17} /><span>{plan.name} · {card.physical ? '가상 + 실물' : '가상카드'}</span><Check size={15} /></div></div>
            <button className="cf-button cf-primary" onClick={() => { patch({ stage: 'issued', issuedAt: Date.now(), delivery: card.physical ? 'preparing' : 'none', last4: '2048' }); onNotify('모의 가상카드를 발급했습니다. 활성화하면 데모 결제에 사용할 수 있어요.'); }}>가상카드 발급 <ArrowRight size={17} /></button>
            <p className="cf-disclaimer">실제 카드 네트워크에 발급 요청을 보내지 않습니다.</p>
          </>}

          {card.stage === 'issued' && <>
            {statusPanel(CreditCard, '카드가 준비되었어요.', '활성화하면 지갑 잔액으로 데모 결제를 시작할 수 있어요.')}
            <div className="cf-reference"><span>모의 가상카드</span><strong>•••• {card.last4}</strong></div>
            {card.physical && <div className="cf-info-box"><Package size={18} /><p>실물카드는 제작 준비 중입니다. 가상카드를 먼저 활성화해서 사용할 수 있어요.</p></div>}
            <button className="cf-button cf-primary" onClick={() => { patch({ stage: 'active', locked: false }); onNotify('가상카드가 활성화되었습니다. 이제 결제 시뮬레이션을 이용할 수 있어요.'); }}>가상카드 활성화 <ArrowRight size={17} /></button>
            <p className="cf-disclaimer">활성화 전에는 카드 결제가 제한됩니다.</p>
          </>}

          {card.stage === 'active' && <>
            <div className="cf-active-header"><div><p className="cf-kicker">YOUR AQUA CARD</p><h2>내 카드</h2></div><span className={`cf-card-status ${card.locked ? 'cf-card-status-locked' : ''}`}>{card.locked ? <LockKeyhole size={13} /> : <CircleCheck size={13} />}{card.locked ? '일시 잠금' : '사용 가능'}</span></div>
            <div className="cf-reference"><span>{plan.name} · 모의 가상카드</span><strong>•••• {card.last4}</strong></div>
            <div className="cf-card-actions"><button className="cf-action" onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={20} /> : <Eye size={20} />}<span>{revealed ? '카드 정보 숨기기' : '카드 정보 보기'}</span></button><button className={`cf-action ${card.locked ? 'cf-action-highlight' : ''}`} onClick={() => { patch({ locked: !card.locked }); onNotify(card.locked ? '카드 잠금을 해제했습니다.' : '카드를 일시 잠금했습니다. 잠금 중에는 결제할 수 없어요.'); }}>{card.locked ? <UnlockKeyhole size={20} /> : <LockKeyhole size={20} />}<span>{card.locked ? '카드 잠금 해제' : '카드 일시 잠금'}</span></button></div>
            {revealed && <div className="cf-demo-details"><span className="cf-simulation-label">모의 카드 정보 · 실제 결제 불가</span><dl><div><dt>카드번호</dt><dd>4242 4242 4242 2048</dd></div><div><dt>유효기간</dt><dd>12/30</dd></div><div><dt>보안코드</dt><dd>123</dd></div></dl></div>}
            <dl className="cf-summary cf-limits"><div><dt>결제 한도</dt><dd>1회 {won(POLICY.perPaymentLimit)}</dd></div><div><dt>일 / 월 한도</dt><dd>{won(POLICY.dailyPaymentLimit)} / {won(POLICY.monthlyPaymentLimit)}</dd></div><div><dt>결제 페이백</dt><dd>{plan.cashbackRate * 100}% · 월 최대 {won(plan.cashbackCap)}</dd></div></dl>
            {card.locked && <div className="cf-info-box cf-warning-box"><LockKeyhole size={18} /><p>새로운 결제는 차단됩니다. 기존 결제 취소와 환불은 처리할 수 있습니다.</p></div>}
            {card.physical && <div className="cf-delivery"><div className="cf-delivery-heading"><Package size={18} /><h3>실물카드 배송</h3><span>{card.physicalActive ? '활성화 완료' : card.delivery === 'preparing' ? '제작 준비' : card.delivery === 'shipped' ? '배송 중' : '배송 완료'}</span></div><ol className="cf-delivery-steps"><li className="cf-delivery-done">제작 준비</li><li className={card.delivery === 'shipped' || card.delivery === 'delivered' ? 'cf-delivery-done' : ''}>배송 중</li><li className={card.delivery === 'delivered' ? 'cf-delivery-done' : ''}>도착</li></ol><p className="cf-delivery-address"><MapPin size={13} /> 샘플 배송지 · 서울특별시 아쿠아로 1</p>{card.delivery === 'preparing' && <button className="cf-button cf-secondary" onClick={() => { patch({ delivery: 'shipped' }); onNotify('실물카드 배송 중 상태를 시뮬레이션했습니다.'); }}><Truck size={16} /> 데모 배송 시작</button>}{card.delivery === 'shipped' && <button className="cf-button cf-secondary" onClick={() => { patch({ delivery: 'delivered' }); onNotify('실물카드가 도착한 상태로 변경했습니다.'); }}><Package size={16} /> 데모 배송 완료</button>}{card.delivery === 'delivered' && !card.physicalActive && <button className="cf-button cf-primary" onClick={() => { patch({ physicalActive: true }); onNotify('모의 실물카드를 활성화했습니다.'); }}>실물카드 활성화 <ArrowRight size={16} /></button>}{card.physicalActive && <p className="cf-physical-active"><CircleCheck size={16} /> 실물카드 활성화가 완료되었습니다.</p>}</div>}
            <p className="cf-disclaimer">모든 카드 정보와 배송 상태는 데모입니다. 실제 카드가 발급되지 않습니다.</p>
          </>}
        </div>
      </div>
    </section>
  );
}
