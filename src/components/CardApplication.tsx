import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Check, ChevronLeft, CircleAlert, CircleCheck, Clock3,
  Eye, EyeOff, LockKeyhole, MapPin, Package, RefreshCw, Truck, UnlockKeyhole,
} from 'lucide-react';
import { PLANS, POLICY } from '../lib/policy';
import type { CardStage, CardState, Plan } from '../lib/types';
import CardVisual from './CardVisual';
import './CardApplication.css';

interface CardApplicationProps {
  card: CardState;
  onChange: (next: CardState) => void;
  onNotify: (message: string) => void;
}

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
const steps = ['본인확인', '카드 선택', '신청 확인'];
const stepByStage: Partial<Record<CardStage, number>> = { identity: 0, plan: 1, details: 1, review: 2 };
const autoDelays: Partial<Record<CardStage, number>> = { submitted: 1_400, approved: 500, issued: 350 };

export default function CardApplication({ card, onChange, onNotify }: CardApplicationProps) {
  const [identityConsent, setIdentityConsent] = useState(false);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ card, onChange, onNotify });
  const plan = PLANS[card.plan];
  const applicationStep = stepByStage[card.stage];
  const selectingCard = card.stage === 'plan' || card.stage === 'details';
  const preparingCard = card.stage === 'submitted' || card.stage === 'approved' || card.stage === 'issued';

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
        current.onChange({ ...current.card, stage: 'issued', issuedAt: Date.now(), last4: '2048', delivery: current.card.physical ? 'preparing' : 'none' });
      } else {
        current.onChange({ ...current.card, stage: 'active', locked: false });
        current.onNotify('카드가 준비되었습니다.');
      }
      timer.current = null;
    }, delay);
    return stopTimer;
  }, [card.stage, toolsOpen]);

  const patch = (change: Partial<CardState>) => onChange({ ...card, ...change });
  const nextStage = (stage: CardStage) => patch({ stage });

  const review = () => {
    setReviewConsent(false);
    // Both choices share one screen; keep the engine's existing ordered stages.
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
    patch({ stage: 'submitted', reference: card.reference || `AQ-DEMO-${String(Date.now()).slice(-8)}`, submittedAt: Date.now() });
    onNotify('신청을 접수했습니다.');
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

  return (
    <section className="card-flow" aria-label="Aqua 카드 신청 및 관리">
      {applicationStep !== undefined && (
        <ol className="cf-steps" aria-label="카드 신청 단계">
          {steps.map((label, index) => <li key={label} className={index === applicationStep ? 'cf-step-current' : index < applicationStep ? 'cf-step-done' : ''} aria-current={index === applicationStep ? 'step' : undefined}><span>{index < applicationStep ? <Check size={14} /> : index + 1}</span><strong>{label}</strong></li>)}
        </ol>
      )}

      <div className="cf-layout cf-layout-compact">
        <aside className="cf-showcase">
          <div className="cf-preview-background"><CardVisual card={card} revealed={revealed && card.stage === 'active'} /></div>
          <div className="cf-visual-caption"><span>{plan.name}</span><span>가상카드</span></div>
        </aside>

        <div className="cf-panel">
          {card.stage === 'not_applied' && <>
            <h2>Aqua Card 신청</h2><p className="cf-panel-description">가상카드를 무료로 발급하고<br />결제할 때마다 페이백을 받으세요.</p>
            <dl className="cf-summary"><div><dt>Basic 월 이용료</dt><dd>무료</dd></div><div><dt>결제 페이백</dt><dd>1% · 월 최대 10,000원</dd></div><div><dt>실물카드</dt><dd>선택 신청 · 발급비 9,900원</dd></div></dl>
            <button className="cf-button cf-primary" data-testid="card-apply" onClick={() => nextStage('identity')}>카드 신청하기 <ArrowRight size={17} /></button>
            <p className="cf-disclaimer">샘플 프로필로 진행하며 실제 카드가 발급되지 않습니다.</p>
          </>}

          {card.stage === 'identity' && <>
            <h2>본인확인</h2><p className="cf-panel-description">이번 체험에는 샘플 프로필을 사용합니다.</p>
            <div className="cf-profile"><span className="cf-avatar">A</span><div><strong>아쿠아 사용자</strong><p>대한민국 · 성인</p></div><span className="cf-profile-status">샘플</span></div>
            <label className="cf-final-consent"><input type="checkbox" data-testid="card-identity-consent" checked={identityConsent} onChange={(event) => setIdentityConsent(event.target.checked)} /><span>샘플 본인확인과 체험 안내를 확인했습니다.</span></label>
            <details className="cf-terms"><summary>체험 안내</summary><p>실제 개인정보나 신분증을 입력하지 않습니다. 카드 발급·자금 이동·비용 청구는 모의 처리되며 체험 데이터는 이 브라우저에 저장됩니다.</p></details>
            <button className="cf-button cf-primary" data-testid="card-identity-next" disabled={!identityConsent} onClick={() => patch({ identityVerified: true, stage: 'plan' })}>다음 <ArrowRight size={17} /></button>
            <button className="cf-text-button" onClick={() => nextStage('not_applied')}><ChevronLeft size={15} /> 돌아가기</button>
          </>}

          {selectingCard && <>
            <h2>카드 선택</h2>
            <fieldset className="cf-options"><legend className="cf-sr-only">카드 플랜</legend>{(['basic', 'plus'] as Plan[]).map((key) => { const option = PLANS[key]; return <label key={key} className={`cf-option ${card.plan === key ? 'cf-option-selected' : ''}`}><input type="radio" name="card-plan" value={key} checked={card.plan === key} onChange={() => patch({ plan: key })} /><span className="cf-option-main"><span className="cf-option-title">{option.name}</span><span className="cf-option-price">{option.monthlyFee === 0 ? '월 이용료 무료' : `월 ${won(option.monthlyFee)}`}</span><span className="cf-option-detail">페이백 {option.cashbackRate * 100}% · 월 최대 {won(option.cashbackCap)}</span></span><span className="cf-selection-mark">{card.plan === key && <Check size={13} />}</span></label>; })}</fieldset>
            <div className="cf-reference"><span>가상카드</span><strong>무료 · 기본 포함</strong></div>
            <div className="cf-physical-option"><label className="cf-final-consent"><input type="checkbox" data-testid="card-physical-choice" checked={card.physical} onChange={(event) => patch({ physical: event.target.checked })} /><span>실물카드도 신청</span></label>
            <p className="cf-panel-description">발급비 {won(POLICY.physicalIssueFee)} · 배송 {POLICY.deliveryEstimate}</p></div>
            {card.physical && <div className="cf-address"><MapPin size={17} /><div><strong>샘플 배송지</strong><p>서울특별시 아쿠아로 1, 데모동 101호</p></div></div>}
            <button className="cf-button cf-primary" data-testid="card-selection-next" onClick={review}>다음 <ArrowRight size={17} /></button>
            <button className="cf-text-button" onClick={backToIdentity}><ChevronLeft size={15} /> 이전</button>
          </>}

          {card.stage === 'review' && <>
            <h2>신청 확인</h2>
            <dl className="cf-summary cf-review-summary"><div><dt>신청자</dt><dd>아쿠아 사용자</dd></div><div><dt>플랜</dt><dd>{plan.name}</dd></div><div className="cf-cost-row"><dt>월 이용료</dt><dd>{plan.monthlyFee === 0 ? '무료' : won(plan.monthlyFee)}</dd></div><div><dt>결제 페이백</dt><dd>{plan.cashbackRate * 100}% · 월 최대 {won(plan.cashbackCap)}</dd></div><div><dt>카드</dt><dd>{card.physical ? '가상 + 실물' : '가상카드'}</dd></div><div className="cf-cost-row"><dt>발급비</dt><dd>{card.physical ? won(POLICY.physicalIssueFee) : '무료'}</dd></div></dl>
            <p className="cf-disclaimer">위 금액과 혜택은 체험 조건입니다. 이용료·발급비는 잔액에서 청구하지 않습니다.</p>
            <label className="cf-final-consent"><input type="checkbox" data-testid="card-review-consent" checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} /><span>선택한 플랜과 신청 조건을 확인했습니다.</span></label>
            <button className="cf-button cf-primary" data-testid="card-submit" disabled={!reviewConsent} onClick={submit}>신청하기 <ArrowRight size={17} /></button>
            <button className="cf-text-button" onClick={() => nextStage('details')}><ChevronLeft size={15} /> 이전</button>
          </>}

          {preparingCard && <div aria-live="polite" data-testid="card-preparing">
            <div className="cf-status-head"><span className="cf-status-icon"><Clock3 size={26} /></span><div><h2>카드 준비 중</h2><p>{card.stage === 'submitted' ? '신청 내용을 확인하고 있습니다.' : card.stage === 'approved' ? '가상카드를 발급하고 있습니다.' : '카드를 활성화하고 있습니다.'}</p></div></div>
            <div className="cf-reference"><span>접수번호</span><strong>{card.reference}</strong></div>
            <p className="cf-disclaimer">모의 심사·발급입니다. 잠시 후 자동으로 완료됩니다.</p>
          </div>}

          {card.stage === 'needs_info' && <>
            <div className="cf-status-head"><span className="cf-status-icon"><CircleAlert size={26} /></span><div><h2>본인확인을 다시 진행해 주세요.</h2><p>샘플 프로필의 재확인이 필요합니다.</p></div></div>
            <div className="cf-reference"><span>접수번호</span><strong>{card.reference}</strong></div>
            <button className="cf-button cf-primary" data-testid="card-resubmit" onClick={() => { setIdentityConsent(false); setReviewConsent(false); setToolsOpen(false); patch({ stage: 'identity', identityVerified: false }); }}>다시 확인하기 <ArrowRight size={17} /></button>
          </>}

          {card.stage === 'rejected' && <>
            <div className="cf-status-head"><span className="cf-status-icon"><CircleAlert size={26} /></span><div><h2>신청이 승인되지 않았습니다.</h2><p>지갑 자산은 그대로 유지됩니다.</p></div></div>
            <button className="cf-button cf-primary" data-testid="card-restart" onClick={restart}>다시 신청하기 <RefreshCw size={17} /></button>
          </>}

          {card.stage === 'active' && <>
            <div className="cf-active-header"><h2>내 카드</h2><span className={`cf-card-status ${card.locked ? 'cf-card-status-locked' : ''}`} data-testid="card-status">{card.locked ? <LockKeyhole size={13} /> : <CircleCheck size={13} />}{card.locked ? '일시 잠금' : '사용 가능'}</span></div>
            <div className="cf-reference"><span>{plan.name} · 가상카드</span><strong>•••• {card.last4}</strong></div>
            <div className="cf-card-actions"><button className="cf-action" data-testid="card-details-toggle" onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={20} /> : <Eye size={20} />}<span>{revealed ? '카드 정보 숨기기' : '카드 정보 보기'}</span></button><button className={`cf-action ${card.locked ? 'cf-action-highlight' : ''}`} data-testid="card-lock-toggle" onClick={() => { patch({ locked: !card.locked }); onNotify(card.locked ? '카드 잠금을 해제했습니다.' : '카드를 일시 잠금했습니다.'); }}>{card.locked ? <UnlockKeyhole size={20} /> : <LockKeyhole size={20} />}<span>{card.locked ? '잠금 해제' : '일시 잠금'}</span></button></div>
            {revealed && <div className="cf-demo-details"><span className="cf-simulation-label">모의 카드 정보 · 실제 결제 불가</span><dl><div><dt>카드번호</dt><dd>4242 4242 4242 2048</dd></div><div><dt>유효기간</dt><dd>12/30</dd></div><div><dt>보안코드</dt><dd>123</dd></div></dl></div>}
            <dl className="cf-summary cf-limits"><div><dt>1회 결제 한도</dt><dd>{won(POLICY.perPaymentLimit)}</dd></div><div><dt>일 / 월 한도</dt><dd>{won(POLICY.dailyPaymentLimit)} / {won(POLICY.monthlyPaymentLimit)}</dd></div><div><dt>결제 페이백</dt><dd>{plan.cashbackRate * 100}% · 월 최대 {won(plan.cashbackCap)}</dd></div></dl>
            {card.locked && <div className="cf-info-box cf-warning-box"><LockKeyhole size={18} /><p>새 결제는 차단됩니다. 기존 결제 취소·환불은 가능합니다.</p></div>}
            {card.physical && <div className="cf-delivery"><div className="cf-delivery-heading"><Package size={18} /><h3>실물카드</h3><span>{card.physicalActive ? '활성화 완료' : card.delivery === 'preparing' ? '제작 준비' : card.delivery === 'shipped' ? '배송 중' : '배송 완료'}</span></div><ol className="cf-delivery-steps"><li className="cf-delivery-done">제작 준비</li><li className={card.delivery === 'shipped' || card.delivery === 'delivered' ? 'cf-delivery-done' : ''}>배송 중</li><li className={card.delivery === 'delivered' ? 'cf-delivery-done' : ''}>도착</li></ol><p className="cf-delivery-address"><MapPin size={13} /> 샘플 배송지 · 서울특별시 아쿠아로 1</p>{card.delivery === 'delivered' && !card.physicalActive && <button className="cf-button cf-primary" data-testid="card-physical-activate" onClick={() => { patch({ physicalActive: true }); onNotify('실물카드를 활성화했습니다.'); }}>실물카드 활성화 <ArrowRight size={16} /></button>}{card.physicalActive && <p className="cf-physical-active"><CircleCheck size={16} /> 활성화 완료</p>}</div>}
            <p className="cf-disclaimer">모의 카드입니다. 실제 카드·배송은 제공되지 않습니다.</p>
          </>}

          {(card.stage === 'submitted' || card.stage === 'active' && card.physical) && <details className="cf-demo-tools" data-testid="card-demo-tools" open={toolsOpen} onToggle={(event) => { stopTimer(); setToolsOpen(event.currentTarget.open); }}><summary>체험 도구</summary>
            {card.stage === 'submitted' && <div className="cf-simulation"><p>도구를 닫으면 모의 심사가 자동으로 진행됩니다.</p><button className="cf-button cf-secondary" data-testid="card-demo-approve" onClick={() => simulateResult('approved')}>심사 승인</button><div className="cf-button-row"><button className="cf-button cf-secondary" data-testid="card-demo-needs-info" onClick={() => simulateResult('needs_info')}>보완 요청</button><button className="cf-button cf-secondary" data-testid="card-demo-reject" onClick={() => simulateResult('rejected')}>신청 거절</button></div></div>}
            {card.stage === 'active' && card.physical && <div className="cf-simulation">{card.delivery === 'preparing' && <button className="cf-button cf-secondary" data-testid="card-demo-shipped" onClick={() => patch({ delivery: 'shipped' })}><Truck size={16} /> 배송 시작</button>}{card.delivery === 'shipped' && <button className="cf-button cf-secondary" data-testid="card-demo-delivered" onClick={() => patch({ delivery: 'delivered' })}><Package size={16} /> 배송 완료</button>}{card.delivery === 'delivered' && <p>배송 완료 상태입니다.</p>}</div>}
          </details>}
        </div>
      </div>
    </section>
  );
}
