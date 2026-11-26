import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ChevronDown, RefreshCw, UnlockKeyhole, X } from 'lucide-react';
import type { CustomerAccessSnapshot } from '../../shared/api';
import { Wordmark } from '../components/Logo';
import { useModal } from '../components/useModal';
import { useIssuerCard } from './useIssuerCard';
import './IssuerCardPanel.css';

interface IssuerCardPanelProps {
  ownerId: string;
  visible: boolean;
  access: CustomerAccessSnapshot | null;
  onSessionExpired: () => void;
}

const waitingStatuses = new Set(['pending', 'in_flight', 'retry']);
const checkedAt = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul',
}).format(timestamp);

function CardFace({ empty }: { empty: boolean }) {
  return <div className={`sa-issuer-stage${empty ? ' is-empty' : ''}`} aria-hidden="true">
    <div className="sa-issuer-card-shadow" />
    <div className="sa-issuer-card-face">
      <div className="sa-issuer-card-edge" />
      <div className="sa-issuer-card-surface">
        <div className="sa-issuer-card-top"><Wordmark height={35} /><span>AQUA CARD</span></div>
        <svg className="sa-issuer-card-contour" viewBox="0 0 400 250" fill="none">
          <path d="M-40 243C84 106 197 263 276 106C309 40 360 25 433 14" />
          <path d="M-40 257C88 125 208 278 290 117C328 48 376 45 435 33" />
          <path d="M-40 271C94 144 222 293 306 130C342 61 389 64 439 53" />
        </svg>
        <div className="sa-issuer-card-bottom"><span>테스트 카드</span></div>
      </div>
    </div>
  </div>;
}

function UnlockConfirmation({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.sa-shell');
    const previous = shell?.inert;
    if (shell) shell.inert = true;
    return () => { if (shell) shell.inert = previous ?? false; };
  }, []);
  useModal(panel, onCancel, cancel);
  return createPortal(<div className="sa-issuer-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={panel} className="sa-issuer-dialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={description} tabIndex={-1} data-testid="issuer-unlock-dialog">
      <button className="sa-issuer-dialog-close" aria-label="닫기" onClick={onCancel}><X size={21} /></button>
      <span className="sa-issuer-dialog-symbol" aria-hidden="true"><UnlockKeyhole size={24} strokeWidth={1.6} /></span>
      <h2 id={title}>잠금을 해제할까요?</h2>
      <p id={description}>잠금 해제가 확인되면 새 결제를 승인할 수 있어요. 이미 승인된 결제의 취소와 환불은 계속 처리됩니다.</p>
      <div className="sa-issuer-dialog-actions">
        <button ref={cancel} className="sa-issuer-button secondary" data-testid="issuer-unlock-cancel" onClick={onCancel}>취소</button>
        <button className="sa-issuer-button" data-testid="issuer-unlock-confirm" onClick={onConfirm}>잠금 해제 요청</button>
      </div>
    </div>
  </div>, document.body);
}

export default function IssuerCardPanel({ ownerId, visible, access, onSessionExpired }: IssuerCardPanelProps) {
  const model = useIssuerCard(ownerId, onSessionExpired);
  const [unlockOpen, setUnlockOpen] = useState<{ cardId: string; version: number } | null>(null);
  const headingId = useId();
  const detailId = useId();
  const [detailOpen, setDetailOpen] = useState(false);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const card = model.snapshot?.card ?? null;
  const locked = card?.confirmedStatus === 'locked';
  const outstanding = model.intents.length > 0;
  const needsReview = card?.command?.status === 'needs_review';
  const queued = card?.command ? waitingStatuses.has(card.command.status) : false;
  const processing = model.submitting || model.awaitingConfirmation || queued;
  const target = model.intents[0]?.targetStatus ?? card?.desiredStatus;
  const targetLabel = target === 'active' ? '잠금 해제' : '잠금';
  const unavailable = !model.fresh && !model.loading && !model.submitting && !outstanding
    && !(model.awaitingConfirmation && model.refreshing);
  const readonly = model.snapshot?.canRequestStatus === false;
  const rejected = card?.command?.status === 'failed';
  const authorizationKnown = access !== null && model.fresh && !model.submitting && !model.awaitingConfirmation && !outstanding && !model.storageError;
  const authorizationAllowed = access?.canTransact === true && card?.desiredStatus === 'active' && card.confirmedStatus === 'active'
    && (!card.command || card.command.status === 'succeeded');
  const authorizationState = !authorizationKnown ? 'unconfirmed' : authorizationAllowed ? 'allowed' : 'blocked';
  const authorizationLabel = authorizationState === 'unconfirmed' ? '확인 필요' : authorizationState === 'allowed' ? '승인 가능' : '승인 중단';
  const closeUnlock = useCallback(() => setUnlockOpen(null), []);

  useEffect(() => {
    if (unlockOpen && (!visible || !access?.canTransact || !model.canChange || !locked || unlockOpen.cardId !== card?.id || unlockOpen.version !== card.version)) setUnlockOpen(null);
  }, [visible, access?.canTransact, model.canChange, locked, card?.id, card?.version, unlockOpen]);

  let stage = locked ? 'locked' : 'active';
  let title = locked ? '카드가 잠겨 있어요' : '카드 잠금 해제';
  let description = locked ? '새 결제는 승인되지 않아요. 이미 승인된 결제의 취소와 환불은 계속 처리돼요.' : '카드를 잠그면 새 결제 승인이 중단돼요.';
  if (model.loading && !model.snapshot) {
    stage = 'loading'; title = '카드 상태를 확인하고 있어요'; description = '잠시만 기다려 주세요.';
  } else if (model.submitting) {
    stage = 'confirming'; title = `${targetLabel} 요청을 보내고 있어요`; description = '처리 결과가 확인되면 화면에 반영할게요.';
  } else if (outstanding || model.storageError) {
    stage = 'confirming'; title = '이전 요청 확인이 필요해요'; description = outstanding ? `${targetLabel} 요청의 접수 여부를 확인해 주세요. 같은 요청으로 다시 확인할 수 있어요.` : '저장된 요청을 확인한 뒤 카드 상태를 변경할 수 있어요.';
  } else if (unavailable) {
    stage = 'unavailable'; title = '상태를 확인할 수 없어요'; description = '연결이 확인되면 현재 상태를 다시 불러올게요.';
  } else if (needsReview) {
    stage = 'review'; title = '카드 상태를 확인하고 있어요'; description = '새 결제 승인은 중단된 상태예요. 요청 결과가 확인되면 알려드릴게요.';
  } else if (model.awaitingConfirmation && !queued) {
    stage = 'pending'; title = '카드 상태를 다시 확인하고 있어요'; description = '요청 결과에 맞춰 최신 상태를 불러오고 있어요.';
  } else if (processing) {
    stage = 'pending'; title = target === 'active' ? '잠금 해제 확인 중' : '잠금 처리 확인 중'; description = target === 'active'
      ? '잠금 해제가 확인될 때까지 새 결제는 승인되지 않아요.'
      : '새 결제 승인은 중단됐어요. 카드 잠금 결과를 확인하고 있어요.';
  } else if (card && rejected) {
    stage = 'rejected'; title = `${targetLabel} 요청이 반영되지 않았어요`; description = '새 결제 승인은 중단된 상태예요. 아래에서 다시 요청할 수 있어요.';
  } else if (model.snapshot && !card) {
    stage = 'empty'; title = '연결된 카드가 없어요'; description = '테스트 카드가 연결되면 잠금을 설정할 수 있어요.';
  } else if (card && !access?.canTransact) {
    description = access ? '계정의 거래가 제한되어 새 결제를 승인할 수 없어요. 카드 잠금과 기존 결제의 취소·환불은 계속 이용할 수 있어요.'
      : '계정 상태를 확인하고 있어요. 확인이 끝나면 새 결제 승인 가능 여부를 알려드릴게요.';
  }
  const showApprovalHeading = Boolean(card) && (stage === 'active' || stage === 'locked');
  const inProgress = ['confirming', 'pending', 'review'].includes(stage);
  const feedback = model.storageError || model.error;
  const compact = stage === 'active' && authorizationState === 'allowed' && model.canChange && !feedback;
  const lastConfirmed = !model.fresh || inProgress || rejected;
  const retryDisabled = !model.fresh || !model.snapshot?.canRequestStatus || model.submitting || model.awaitingConfirmation || Boolean(model.storageError);

  function confirmUnlock() {
    if (!access?.canTransact || !model.canChange || !locked || !unlockOpen || unlockOpen.cardId !== card?.id || unlockOpen.version !== card.version) { setUnlockOpen(null); return; }
    setUnlockOpen(null);
    model.requestStatus('active');
    requestAnimationFrame(() => statusHeading.current?.focus({ preventScroll: true }));
  }

  return <section className="sa-issuer-panel" aria-labelledby={headingId} data-testid="issuer-card-panel"
    data-card-id={card?.id ?? ''} data-confirmed-status={card?.confirmedStatus ?? ''}
    data-command-status={card?.command?.status ?? ''} data-fresh={String(model.fresh)} data-stage={stage}>
    <header className="sa-issuer-heading"><h2 id={headingId}>내 카드</h2>
      <div className="sa-issuer-heading-actions">
        {compact && <button type="button" className="sa-issuer-disclosure" data-testid="issuer-details-toggle"
          aria-label="카드 상태 상세" aria-controls={detailId} aria-expanded={detailOpen} onClick={() => setDetailOpen(!detailOpen)}>
          상태 상세<ChevronDown size={14} aria-hidden="true" />
        </button>}
        <button className="sa-icon-button" data-testid="issuer-refresh" disabled={model.refreshing || model.submitting}
        onClick={model.refresh} aria-label="카드 상태 다시 확인"><RefreshCw size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="sa-issuer-content">
      <CardFace empty={!card} />
      <div className={`sa-issuer-details${compact ? ' is-compact' : ''}`}>
        <div className="sa-issuer-state" aria-live="polite" aria-atomic="true">
          <h3 ref={statusHeading} tabIndex={-1} data-testid="issuer-request-state">{showApprovalHeading
            ? <span data-testid="issuer-authorization-state" data-authorization={authorizationState}>결제 {authorizationLabel}</span>
            : title}</h3>
          {(stage !== 'active' || !access?.canTransact) && <p {...(stage === 'empty' ? { 'data-testid': 'issuer-empty' } : {})}>{description}</p>}
        </div>
        {card && <dl className="sa-issuer-confirmed" id={detailId} hidden={compact && !detailOpen}>
          {!showApprovalHeading && <div><dt>새 결제 승인</dt><dd data-testid="issuer-authorization-state" data-authorization={authorizationState}>{authorizationLabel}</dd></div>}
          <div><dt>{lastConfirmed ? '마지막 확인 상태' : '카드 상태'}</dt>
            <dd data-testid="issuer-confirmed-state">{locked ? '잠금' : '잠금 해제'}</dd></div>
          <div><dt>변경 시각</dt><dd><time dateTime={new Date(card.updatedAt).toISOString()}>{checkedAt(card.updatedAt)}</time></dd></div>
        </dl>}
        {readonly && <p className="sa-issuer-readonly" data-testid="issuer-readonly">현재는 카드 상태만 확인할 수 있어요.</p>}
        {card && !readonly && <div className="sa-issuer-actions">
          {locked ? <button className="sa-issuer-button" data-testid="issuer-unlock" disabled={!access?.canTransact || !model.canChange} onClick={() => { if (access?.canTransact && model.canChange) setUnlockOpen({ cardId: card.id, version: card.version }); }}>잠금 해제</button>
            : <button className="sa-issuer-button secondary" data-testid="issuer-lock" disabled={!model.canChange} onClick={() => model.requestStatus('locked')}>잠그기</button>}
        </div>}
        {outstanding && <button className="sa-issuer-retry" data-testid="issuer-retry" disabled={retryDisabled} onClick={model.retryIntent}>이전 요청 확인<ArrowRight size={16} /></button>}
        {feedback && <p className="sa-issuer-error" role="alert" data-testid="issuer-error">{feedback}</p>}
        {!feedback && model.notice && <p className="sa-issuer-notice" role="status">{model.notice}</p>}
      </div>
    </div>
    {visible && unlockOpen && access?.canTransact && model.canChange && locked && unlockOpen.cardId === card?.id && unlockOpen.version === card.version && <UnlockConfirmation onCancel={closeUnlock} onConfirm={confirmUnlock} />}
  </section>;
}
