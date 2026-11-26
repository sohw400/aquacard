import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import type { AccountSnapshot, TransferResult } from '../../shared/api';
import { ApiError, api, errorMessage, outcomeUncertain, type Recipient } from './api';
import { clearPending, storePending, type PendingTransfer } from './pending';
import './TransferDialog.css';

type Stage = 'recipient' | 'amount' | 'review' | 'sending' | 'unknown' | 'receipt' | 'failed';
const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export default function TransferDialog({ account, pending, onIntentChange, onRefresh, onUnauthorized, onClose }: {
  account: AccountSnapshot;
  pending: PendingTransfer | null;
  onIntentChange: (ownerId: string, intent: PendingTransfer | null) => void;
  onRefresh: () => Promise<void>;
  onUnauthorized: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>(pending ? 'unknown' : 'recipient');
  const [tag, setTag] = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [intent, setIntent] = useState<PendingTransfer | null>(pending);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [error, setError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  const stageRef = useRef(stage);
  const inFlight = useRef(false);
  const lookupVersion = useRef(0);
  closeRef.current = onClose; stageRef.current = stage;
  const amount = Number(amountInput);
  const limit = Math.max(0, Math.min(account.balanceWon, account.limits.available, account.limits.perTransfer, account.limits.daily - account.limits.sentToday, account.limits.monthly - account.limits.sentMonth));
  const amountIssue = !amountInput ? '' : !Number.isSafeInteger(amount) || amount < 1_000
    ? '1,000원 이상, 원 단위로 입력해 주세요.'
    : amount > limit ? `현재 보낼 수 있는 금액은 ${money(limit)}이에요.` : '';
  const normalizedTag = tag.trim().replace(/^@/, '').toLowerCase();
  const canStartTransfer = account.access?.canTransact === true;
  const accessBlocked = !canStartTransfer && ['recipient', 'amount', 'review'].includes(stage);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape' && stageRef.current !== 'sending') closeRef.current();
      if (event.key === 'Tab') {
        const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, [tabindex="0"]') ?? []).filter((node) => node.getClientRects().length > 0);
        const first = targets[0]; const last = targets[targets.length - 1];
        if (!first) { event.preventDefault(); headingRef.current?.focus(); return; }
        if (!targets.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = ref.current?.querySelector<HTMLInputElement>('input');
      (input ?? headingRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  async function lookup(event?: FormEvent) {
    event?.preventDefault(); if (lookingUp) return;
    if (!canStartTransfer) return;
    if (recipient?.tag === normalizedTag) { setError(''); setStage('amount'); return; }
    const version = ++lookupVersion.current;
    setError(''); setRecipient(null);
    if (!/^[a-z0-9._]{3,20}$/.test(normalizedTag)) { setError('받는 분의 Aqua 태그를 확인해 주세요.'); return; }
    try {
      setLookingUp(true);
      const response = await api.member(normalizedTag);
      if (version !== lookupVersion.current) return;
      if (response.member.id === account.user.id) { setError('본인에게는 송금할 수 없습니다.'); return; }
      setRecipient(response.member);
    } catch (issue) {
      if (version !== lookupVersion.current) return;
      if (issue instanceof ApiError && issue.status === 401) onUnauthorized();
      else setError(errorMessage(issue));
    } finally { if (version === lookupVersion.current) setLookingUp(false); }
  }

  function review(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!canStartTransfer) return;
    if (!amountInput || amountIssue) { setError(amountIssue || '금액을 입력해 주세요.'); return; }
    setStage('review');
  }

  async function performTransfer(request: PendingTransfer) {
    if (inFlight.current) return;
    inFlight.current = true; setStage('sending'); setError('');
    try {
      const response = await api.transfer({ recipientTag: request.recipientTag, amountWon: request.amountWon }, request.key, account.user.id);
      if (!response.transfer || typeof response.transfer.id !== 'string' || response.transfer.amountWon !== request.amountWon || !Number.isSafeInteger(response.balanceWon) || response.balanceWon < 0) throw new Error('Unexpected transfer response.');
      clearPending(account.user.id); setIntent(null); onIntentChange(account.user.id, null);
      setResult(response); setStage('receipt');
      void onRefresh();
    } catch (issue) {
      if (outcomeUncertain(issue)) {
        setStage('unknown');
        setError(issue instanceof ApiError && issue.status === 429 ? issue.message : '');
        if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) onUnauthorized();
      } else {
        clearPending(account.user.id); setIntent(null); onIntentChange(account.user.id, null);
        setError(errorMessage(issue)); setStage('failed');
        void onRefresh();
      }
    } finally { inFlight.current = false; }
  }

  function confirm() {
    if (!canStartTransfer || !recipient || inFlight.current) return;
    const request: PendingTransfer = { key: newKey(), recipientTag: recipient.tag, amountWon: amount, createdAt: Date.now() };
    try { storePending(account.user.id, request); }
    catch { setError('송금 요청을 이 브라우저에 보관할 수 없습니다. 저장 공간 설정을 확인한 뒤 다시 시도해 주세요.'); return; }
    setIntent(request); onIntentChange(account.user.id, request);
    void performTransfer(request);
  }

  const title = stage === 'recipient' ? '받는 분' : stage === 'amount' ? '송금 금액' : stage === 'review' ? '송금 확인' : stage === 'receipt' ? '송금 영수증' : stage === 'failed' ? '송금하지 못했습니다' : stage === 'sending' ? '송금 처리 중' : '송금 결과 미확인';
  const back = stage === 'amount' || stage === 'review';
  const displayedTag = result?.transfer.counterpartyTag ?? intent?.recipientTag ?? recipient?.tag ?? '';
  const displayedAmount = result?.transfer.amountWon ?? intent?.amountWon ?? amount;

  const stepNumber = stage === 'recipient' ? 1 : stage === 'amount' ? 2 : stage === 'review' ? 3 : null;

  return <div className="sa-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && stage !== 'sending') onClose();
  }}>
    <section className="sa-modal sa-transfer-sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby="server-transfer-heading" data-testid="server-transfer-dialog">
      <header className="sa-modal-header">
        <div className="sa-transfer-title"><h2 id="server-transfer-heading" ref={headingRef} tabIndex={-1}>{title}</h2>
          {stepNumber && <span className="sa-step-count" aria-label={`3단계 중 ${stepNumber}단계`}>{stepNumber} / 3</span>}
        </div>
        <div className="sa-modal-header-actions">
          {back && <button className="sa-icon-button" aria-label="이전 단계" onClick={() => {
            setError(''); setStage(stage === 'review' ? 'amount' : 'recipient');
          }}><ArrowLeft size={20} /></button>}
          <button className="sa-icon-button" aria-label="송금 창 닫기" data-testid="transfer-close" disabled={stage === 'sending'} onClick={onClose}><X size={21} /></button>
        </div>
      </header>
      <div className="sa-modal-body">
        {accessBlocked && <p className="sa-error" role="alert" data-testid="transfer-access-blocked">현재 계정에서는 새 송금을 할 수 없습니다. 계정 상태를 확인해 주세요.</p>}

        {stage === 'recipient' && <>
          <form id="server-recipient-form" className="sa-recipient-search" onSubmit={lookup}>
            <div className="sa-field"><label htmlFor="recipient-tag">받는 분의 Aqua 태그</label>
              <div className="sa-tag-input"><span aria-hidden="true">@</span>
                <input id="recipient-tag" data-testid="transfer-recipient" value={tag} onChange={(event) => {
                  lookupVersion.current++; setLookingUp(false); setTag(event.target.value); setRecipient(null); setError('');
                }} autoCapitalize="none" spellCheck={false} autoComplete="off" maxLength={21} placeholder="aqua.member" required />
              </div>
            </div>
          </form>
          {recipient && <div className="sa-recipient-result" role="status" data-testid="transfer-recipient-result">
            <div><strong>{recipient.name}</strong><span>@{recipient.tag}</span></div>
          </div>}
        </>}

        {stage === 'amount' && <form id="server-transfer-amount-form" onSubmit={review}>
          <div className="sa-recipient-mini"><strong>{recipient?.name}님에게</strong><span>@{recipient?.tag}</span></div>
          <div className="sa-field sa-transfer-amount-field">
            <label htmlFor="server-transfer-amount">보낼 금액</label>
            <div className="sa-amount-input">
              <input id="server-transfer-amount" data-testid="transfer-amount" type="number" inputMode="numeric" min={1000} step={1}
                value={amountInput} onChange={(event) => { setAmountInput(event.target.value); setError(''); }} placeholder="0" required
                aria-invalid={Boolean(amountIssue)} aria-describedby={amountIssue ? 'transfer-amount-issue' : 'transfer-available-hint'} /><span>원</span>
            </div>
            <div className="sa-amount-help"><span id="transfer-available-hint">송금 가능 {money(limit)}</span>
              <button type="button" className="sa-text-button" data-testid="transfer-max" disabled={limit < 1000}
                onClick={() => { setAmountInput(String(limit)); setError(''); }}>최대</button>
            </div>
            {amountIssue && <p id="transfer-amount-issue" className="sa-error" role="alert">{amountIssue}</p>}
          </div>
          <details className="sa-limits"><summary>송금 한도</summary><dl>
            <div><dt>최소 송금액</dt><dd>1,000원</dd></div>
            <div><dt>1회 최대</dt><dd>{money(account.limits.perTransfer)}</dd></div>
            <div><dt>오늘 남은 한도</dt><dd>{money(Math.max(0, account.limits.daily - account.limits.sentToday))}</dd></div>
            <div><dt>이번 달 남은 한도</dt><dd>{money(Math.max(0, account.limits.monthly - account.limits.sentMonth))}</dd></div>
          </dl></details>
        </form>}

        {stage === 'review' && <>
          <div className="sa-transfer-review-heading"><span>{recipient?.name}님에게</span><strong>{money(amount)}</strong></div>
          <dl className="sa-summary">
            <div className="sa-summary-row"><dt>받는 태그</dt><dd>@{recipient?.tag}</dd></div>
            <div className="sa-summary-row"><dt>수수료</dt><dd>0원</dd></div>
            <div className="sa-summary-row"><dt>보낸 뒤 예상 잔액</dt><dd>{money(Math.max(0, account.balanceWon - amount))}</dd></div>
          </dl>
          <p className="sa-field-help">테스트 잔액으로 보내는 송금이에요.</p>
        </>}

        {stage === 'sending' && <div className="sa-progress-state" role="status" data-testid="transfer-status" data-status="pending">
          <h3>@{displayedTag}에게 {money(displayedAmount)}</h3><p>송금 결과를 기다리고 있어요.</p>
        </div>}
        {stage === 'unknown' && <div className="sa-unknown-state" data-testid="transfer-status" data-status="unknown">
          <div className="sa-transfer-review-heading"><span id="transfer-retry-recipient">@{displayedTag}에게 요청한 금액</span><strong>{money(displayedAmount)}</strong></div>
          <p className="sa-transfer-pending-note" id="transfer-retry-outcome">재시도하면 아직 처리되지 않은 송금은 지금 실행돼요. 이미 송금됐다면 추가 차감 없이 영수증을 보여줘요.</p>
          <details className="sa-request-details"><summary>요청 번호 보기</summary><code>{intent?.key}</code></details>
        </div>}
        {stage === 'failed' && <div className="sa-unknown-state" data-testid="transfer-status" data-status="failed">
          <h3>잔액은 차감되지 않았습니다.</h3><p>아래 사유를 확인한 뒤 다시 보내 주세요.</p>
        </div>}
        {stage === 'receipt' && result && <div className="sa-receipt" data-testid="transfer-status" data-status="completed">
          <strong className="sa-receipt-amount" data-testid="transfer-receipt-amount">{money(result.transfer.amountWon)}</strong>
          <p>{result.transfer.counterpartyName}님에게 보냈어요.</p>
          <dl className="sa-summary">
            <div className="sa-summary-row"><dt>받는 태그</dt><dd>@{result.transfer.counterpartyTag}</dd></div>
            <div className="sa-summary-row"><dt>송금 일시</dt><dd>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(result.transfer.createdAt)}</dd></div>
            <div className="sa-summary-row"><dt>수수료</dt><dd>0원</dd></div>
            <div className="sa-summary-row"><dt>송금 직후 잔액</dt><dd data-testid="transfer-balance-after">{money(result.balanceWon)}</dd></div>
          </dl>
        </div>}
        {error && <p className="sa-error" role="alert" data-testid="transfer-error">{error}</p>}
      </div>
      <footer className="sa-modal-footer">
        {stage === 'recipient' && (recipient
          ? <button className="sa-primary sa-full" data-testid="transfer-next" disabled={!canStartTransfer || lookingUp}
            onClick={() => { setStage('amount'); setError(''); }}>금액 입력</button>
          : <button className="sa-primary sa-full" data-testid="transfer-lookup" disabled={lookingUp || !canStartTransfer || !normalizedTag}
            type="submit" form="server-recipient-form">{lookingUp ? '찾는 중' : '받는 분 찾기'}</button>)}
        {stage === 'amount' && <button className="sa-primary sa-full" data-testid="transfer-review"
          disabled={!canStartTransfer || !amountInput || Boolean(amountIssue)} type="submit" form="server-transfer-amount-form">보낼 내용 확인</button>}
        {stage === 'review' && <button className="sa-primary sa-full" data-testid="transfer-confirm" disabled={!canStartTransfer} onClick={confirm}>{money(amount)} 보내기</button>}
        {stage === 'unknown' && <button className="sa-primary sa-full" data-testid="transfer-retry" aria-describedby="transfer-retry-recipient transfer-retry-outcome" disabled={!intent} onClick={() => {
          if (intent) void performTransfer(intent);
        }}>{money(displayedAmount)} 송금 재시도</button>}
        {(stage === 'receipt' || stage === 'failed') && <button className="sa-primary sa-full" data-testid="transfer-done" onClick={onClose}>확인</button>}
        {stage === 'sending' && <button className="sa-primary sa-full" disabled>확인 중</button>}
      </footer>
    </section>
  </div>;
}
