import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, X } from 'lucide-react';
import type { AccountSnapshot, TransferResult } from '../../shared/api';
import { ApiError, api, errorMessage, outcomeUncertain, type Recipient } from './api';
import { clearPending, storePending, type PendingTransfer } from './pending';

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
        if (!first) return;
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
    if (!Number.isSafeInteger(amount) || amount < 1_000) { setError('송금 금액은 1,000원 이상의 정수로 입력해 주세요.'); return; }
    if (amount > limit) { setError(`현재 송금할 수 있는 금액은 ${money(limit)}입니다.`); return; }
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
        setError(issue instanceof ApiError && issue.status === 429 ? issue.message : '송금 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
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

  const title = stage === 'recipient' ? '받는 분' : stage === 'amount' ? '송금 금액' : stage === 'review' ? '송금 확인' : stage === 'receipt' ? '송금 완료' : stage === 'failed' ? '송금하지 못했습니다' : stage === 'sending' ? '송금 처리 중' : '송금 결과 확인';
  const back = stage === 'amount' || stage === 'review';
  const displayedTag = result?.transfer.counterpartyTag ?? intent?.recipientTag ?? recipient?.tag ?? '';
  const displayedAmount = result?.transfer.amountWon ?? intent?.amountWon ?? amount;

  return <div className="sa-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && stage !== 'sending') onClose(); }}><section className="sa-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="server-transfer-heading" data-testid="server-transfer-dialog">
    <header className="sa-modal-header"><div>{['recipient', 'amount', 'review'].includes(stage) && <span className="sa-progress-label">{stage === 'recipient' ? 1 : stage === 'amount' ? 2 : 3} / 3</span>}<h2 id="server-transfer-heading" ref={headingRef} tabIndex={-1}>{title}</h2></div><div className="sa-modal-header-actions">{back && <button className="sa-icon-button" aria-label="이전 단계" onClick={() => { setError(''); setStage(stage === 'review' ? 'amount' : 'recipient'); }}><ArrowLeft size={20} /></button>}<button className="sa-icon-button" aria-label="송금 창 닫기" data-testid="transfer-close" disabled={stage === 'sending'} onClick={onClose}><X size={21} /></button></div></header>
    <div className="sa-modal-body">
      {accessBlocked && <p className="sa-error" role="alert" data-testid="transfer-access-blocked">현재 계정에서는 새 송금을 할 수 없습니다. 홈에서 계정 상태를 확인해 주세요.</p>}
      {stage === 'recipient' && <><p className="sa-muted">받는 분의 Aqua 태그를 입력해 주세요.</p><form className="sa-recipient-search" onSubmit={lookup}><div className="sa-field"><label htmlFor="recipient-tag">Aqua 태그</label><div className="sa-tag-input"><span>@</span><input id="recipient-tag" data-testid="transfer-recipient" value={tag} onChange={(event) => { lookupVersion.current++; setLookingUp(false); setTag(event.target.value); setRecipient(null); setError(''); }} autoCapitalize="none" spellCheck={false} autoComplete="off" maxLength={21} placeholder="aqua.member" required /></div></div><button className="sa-secondary" data-testid="transfer-lookup" disabled={lookingUp || !canStartTransfer} type="submit">{lookingUp ? '조회 중' : '조회'}</button></form>{recipient && <div className="sa-recipient-result" data-testid="transfer-recipient-result"><span className="sa-person-avatar">{recipient.name.slice(0, 1)}</span><div><strong>{recipient.name}</strong><span>@{recipient.tag}</span></div><Check size={18} /><p>태그와 이름을 확인해 주세요.</p></div>}</>}
      {stage === 'amount' && <form id="server-transfer-amount-form" onSubmit={review}><div className="sa-recipient-mini"><strong>{recipient?.name}</strong><span>@{recipient?.tag}</span></div><div className="sa-field sa-transfer-amount-field"><label htmlFor="server-transfer-amount">보낼 금액</label><div className="sa-amount-input"><input id="server-transfer-amount" data-testid="transfer-amount" type="number" inputMode="numeric" min={1000} step={1} value={amountInput} onChange={(event) => { setAmountInput(event.target.value); setError(''); }} placeholder="0" required /><span>원</span></div><div className="sa-amount-help"><span>송금 가능 {money(limit)}</span><button type="button" className="sa-text-button" data-testid="transfer-max" onClick={() => setAmountInput(String(limit))}>최대</button></div></div><details className="sa-limits"><summary>송금 한도</summary><dl><div><dt>1회 최대</dt><dd>{money(account.limits.perTransfer)}</dd></div><div><dt>오늘 남은 한도</dt><dd>{money(Math.max(0, account.limits.daily - account.limits.sentToday))}</dd></div><div><dt>이번 달 남은 한도</dt><dd>{money(Math.max(0, account.limits.monthly - account.limits.sentMonth))}</dd></div></dl></details></form>}
      {stage === 'review' && <><div className="sa-transfer-review-heading"><span>{recipient?.name}님에게</span><strong>{money(amount)}</strong></div><dl className="sa-summary"><div className="sa-summary-row"><dt>받는 태그</dt><dd>@{recipient?.tag}</dd></div><div className="sa-summary-row"><dt>수수료</dt><dd>0원</dd></div><div className="sa-summary-row"><dt>차감할 금액</dt><dd>{money(amount)}</dd></div><div className="sa-summary-row"><dt>송금 후 예상 잔액</dt><dd>{money(Math.max(0, account.balanceWon - amount))}</dd></div></dl><p className="sa-field-help">테스트 계정 사이에서 잔액을 이동합니다. 실제 자금은 이동하지 않습니다.</p></>}
      {stage === 'sending' && <div className="sa-progress-state" role="status" data-testid="transfer-status" data-status="pending"><span className="sa-progress-indicator" /><h3>요청을 처리하고 있습니다.</h3><p>결과가 확인될 때까지 기다려 주세요.</p></div>}
      {stage === 'unknown' && <div className="sa-unknown-state" data-testid="transfer-status" data-status="unknown"><h3>처리 결과를 확인해 주세요.</h3><p>결과가 확인되기 전에는 새 송금을 진행할 수 없습니다. 다시 확인해도 같은 요청으로 처리됩니다.</p><dl className="sa-summary"><div className="sa-summary-row"><dt>받는 태그</dt><dd>@{displayedTag}</dd></div><div className="sa-summary-row"><dt>요청 금액</dt><dd>{money(displayedAmount)}</dd></div></dl><details className="sa-request-details"><summary>요청 번호</summary><code>{intent?.key}</code></details></div>}
      {stage === 'failed' && <div className="sa-unknown-state" data-testid="transfer-status" data-status="failed"><h3>잔액은 차감되지 않았습니다.</h3><p>홈으로 돌아가 정보를 확인한 뒤 새 송금을 진행해 주세요.</p></div>}
      {stage === 'receipt' && result && <div className="sa-receipt" data-testid="transfer-status" data-status="completed"><span className="sa-success"><Check size={19} />송금 완료</span><strong className="sa-receipt-amount" data-testid="transfer-receipt-amount">{money(result.transfer.amountWon)}</strong><p>{result.transfer.counterpartyName} · @{result.transfer.counterpartyTag}</p><dl className="sa-summary"><div className="sa-summary-row"><dt>송금 일시</dt><dd>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(result.transfer.createdAt)}</dd></div><div className="sa-summary-row"><dt>송금 직후 잔액</dt><dd data-testid="transfer-balance-after">{money(result.balanceWon)}</dd></div></dl><p className="sa-field-help">현재 잔액과 받은 송금은 홈에서 확인할 수 있습니다.</p></div>}
      {error && <p className="sa-error" role="alert" data-testid="transfer-error">{error}</p>}
    </div>
    <footer className="sa-modal-footer">{stage === 'recipient' ? <button className="sa-primary sa-full" data-testid="transfer-next" disabled={!canStartTransfer || !recipient || lookingUp} onClick={() => { setStage('amount'); setError(''); }}>금액 입력</button> : stage === 'amount' ? <button className="sa-primary sa-full" data-testid="transfer-review" disabled={!canStartTransfer} type="submit" form="server-transfer-amount-form">다음</button> : stage === 'review' ? <button className="sa-primary sa-full" data-testid="transfer-confirm" disabled={!canStartTransfer} onClick={confirm}>{money(amount)} 보내기</button> : stage === 'unknown' ? <button className="sa-primary sa-full" data-testid="transfer-retry" disabled={!intent} onClick={() => { if (intent) void performTransfer(intent); }}>송금 결과 다시 확인</button> : stage === 'receipt' || stage === 'failed' ? <button className="sa-primary sa-full" data-testid="transfer-done" onClick={onClose}>확인</button> : <button className="sa-primary sa-full" disabled>확인 중</button>}</footer>
  </section></div>;
}
