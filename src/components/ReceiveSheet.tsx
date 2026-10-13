import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, Copy, PencilLine, X } from 'lucide-react';
import { useModal } from './useModal';
import QrCode from './QrCode';
import { Toggle } from './ui';
import { maskName, normalizeTag, tagIssue, tagLink } from '../lib/directory';
import { josa, ro } from '../lib/format';
import type { Account, Action, AppState } from '../lib/types';
import './InternalTransferDialog.css';
import './SendSheet.css';
import './ReceiveSheet.css';

/** How other members reach this account: the tag, its QR code and, when allowed, the phone number. */
export default function ReceiveSheet({ account, onClose, dispatch, notify }: {
  account: Account; onClose: () => void;
  dispatch: (action: Action) => AppState; notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  useModal(panel, onClose, heading);
  const firstView = useRef(true);
  // Switching between the code and the edit form moves focus with it.
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    (editing ? input.current : heading.current)?.focus();
  }, [editing]);

  const typed = normalizeTag(draft);
  const issue = typed === account.tag ? '지금 쓰고 있는 태그예요.' : tagIssue(typed);
  // Rules show once there is enough to judge, or after a save attempt.
  const message = error || (typed.length >= 3 ? issue : '');

  async function copyTag() {
    try { await navigator.clipboard.writeText(`@${account.tag}`); setCopied('done'); }
    catch { setCopied('failed'); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!typed || issue) { setError(issue || '새 태그를 넣어 주세요.'); return; }
    try {
      dispatch({ type: 'SET_TAG', tag: typed });
      notify(`태그를 ${ro(`@${typed}`)} 바꿨어요.`);
      setEditing(false); setError(''); setCopied('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '바꾸지 못했어요. 다시 시도해 주세요.');
    }
  }
  function findByPhone(enabled: boolean) {
    try {
      dispatch({ type: 'SET_FIND_BY_PHONE', enabled });
      notify(enabled ? '이제 휴대폰 번호로도 나를 찾을 수 있어요.' : '휴대폰 번호로는 나를 찾을 수 없게 했어요.');
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : '바꾸지 못했어요. 다시 시도해 주세요.', 'error');
    }
  }

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog send-sheet receive-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1} data-testid="receive-sheet">
      <header className="itd-header">
        <div className="send-head">{editing && <button type="button" className="itd-close send-back" aria-label="이전" onClick={() => { setEditing(false); setError(''); }}><ChevronLeft size={22} /></button>}<h2 id={`${uid}-title`} ref={heading} tabIndex={-1}>{editing ? '태그 바꾸기' : '내 태그와 QR'}</h2></div>
        <button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="itd-body">
        {!editing ? <>
          <div className="receive-card">
            <QrCode value={tagLink(account.tag)} size={196} label={`내 태그 @${account.tag} QR 코드`} />
            <strong className="receive-tag" data-testid="receive-tag">@{account.tag}</strong>
            <span className="receive-name">{maskName(account.name)}</span>
          </div>
          <p className="receive-help">Aqua 회원이 이 QR을 찍거나 태그를 넣으면 바로 보낼 수 있어요. 받을 때 수수료는 없어요.</p>
          <div className="receive-actions">
            <button type="button" className="itd-button itd-secondary" data-testid="receive-copy" onClick={copyTag}><Copy size={17} aria-hidden="true" />태그 복사</button>
            <button type="button" className="itd-button itd-secondary" data-testid="receive-edit" onClick={() => { setDraft(''); setError(''); setEditing(true); }}><PencilLine size={17} aria-hidden="true" />태그 바꾸기</button>
          </div>
          {copied && <p className={copied === 'done' ? 'receive-note' : 'itd-error'} role="status">{copied === 'done' ? `${josa(`@${account.tag}`, '을', '를')} 복사했어요.` : '복사하지 못했어요. 태그를 길게 눌러 복사해 주세요.'}</p>}
          <div className="receive-phone">
            <Toggle checked={account.findByPhone} onChange={findByPhone} label="휴대폰 번호로 찾기" detail="켜면 내 번호를 아는 회원이 번호 전체를 넣어 나를 찾을 수 있어요. 이름은 가려서 보여 줘요." testId="find-by-phone" />
          </div>
        </> : <form onSubmit={save} noValidate>
          <label className="send-tag-field" htmlFor={`${uid}-tag`}><span aria-hidden="true">@</span><input ref={input} id={`${uid}-tag`} data-testid="tag-input" value={draft} maxLength={21} placeholder={account.tag} onChange={(event) => { setDraft(event.target.value); setError(''); }} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${uid}-rules`} /></label>
          {message ? <p className="itd-error" aria-live="polite" data-testid="tag-issue">{message}</p>
            : typed.length >= 3 && <p className="receive-note receive-available" aria-live="polite" data-testid="tag-available"><Check size={15} strokeWidth={2.6} aria-hidden="true" />쓸 수 있는 태그예요.</p>}
          <ul className="receive-rules" id={`${uid}-rules`}>
            <li>영문 소문자, 숫자, 점(.), 밑줄(_)로 3~20자예요.</li>
            <li>바꾸면 {ro(`@${account.tag}`)}는 더 이상 받을 수 없어요. 내 QR도 새 태그로 바뀌어요.</li>
          </ul>
          <button type="submit" className="itd-button itd-primary send-next" data-testid="tag-save" disabled={!typed || Boolean(issue)}>{typed ? `${ro(`@${typed}`)} 바꾸기` : '바꾸기'}</button>
        </form>}
      </div>
    </section>
  </div>;
}
