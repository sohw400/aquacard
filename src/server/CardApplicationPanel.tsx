import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardApplication, CardApplicationSnapshot, CardApplicationStatus } from '../../shared/api';
import { api, ApiError } from './api';
import { useMemberAction } from './useMemberAction';

type ApplicationCommand = { form: CardApplication['form'] } | { applicationId: string; expectedVersion: number };

function isCommand(value: unknown): value is ApplicationCommand {
  if (!value || typeof value !== 'object') return false;
  if ('form' in value) return Object.keys(value).length === 1 && (value.form === 'virtual' || value.form === 'physical');
  return Object.keys(value).length === 2 && 'applicationId' in value && typeof value.applicationId === 'string'
    && value.applicationId.length > 0 && value.applicationId.length <= 128 && 'expectedVersion' in value
    && Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) >= 0;
}

const headings: Record<CardApplicationStatus, string> = {
  submitted: '심사 중', approved: '발급 준비 중', declined: '발급되지 않았어요', issued: '발급 완료',
  dispatched: '배송 중', delivered: '배송 완료', active: '사용 중',
};
const descriptions: Record<CardApplicationStatus, string> = {
  submitted: '심사 결과가 도착하면 여기에서 확인할 수 있어요.',
  approved: '심사를 통과했어요. 카드 발급을 기다리고 있어요.',
  declined: '발급 심사를 통과하지 못했어요.',
  issued: '카드 발급이 확인됐어요.',
  dispatched: '실물카드가 발송됐어요. 배송이 완료되면 사용을 시작할 수 있어요.',
  delivered: '실물카드를 받았다면 사용을 시작해 주세요.',
  active: '카드를 사용할 수 있어요.',
};

function sessionExpired(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.code === 'SESSION_CHANGED');
}

export default function CardApplicationPanel({ ownerId, visible, onSessionExpired, onActivated }: {
  ownerId: string; visible: boolean; onSessionExpired: () => void; onActivated: () => void;
}) {
  const [snapshot, setSnapshot] = useState<CardApplicationSnapshot | null>(null);
  const [fresh, setFresh] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<CardApplication['form']>('virtual');
  const expired = useRef(onSessionExpired);
  const activated = useRef(onActivated);
  expired.current = onSessionExpired;
  activated.current = onActivated;
  const refresh = useCallback(() => {
    setFresh(false);
    setRevision(current => current + 1);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setFresh(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api.cardApplication(ownerId, controller.signal);
        if (controller.signal.aborted) return;
        if (typeof data.canApply !== 'boolean' || typeof data.canActivate !== 'boolean'
          || (data.application !== null && (!data.application || !Object.hasOwn(headings, data.application.status)
            || !isCommand({ applicationId: data.application.id, expectedVersion: data.application.version })))) {
          throw new Error();
        }
        setSnapshot(data); setFresh(true); setLoadError('');
        if (data.application?.status === 'active') activated.current();
        if (data.application && !['declined', 'active'].includes(data.application.status)) timer = setTimeout(load, 10_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFresh(false);
        if (sessionExpired(error)) expired.current();
        else setLoadError('신청 상태를 확인하지 못했어요. 다시 확인해 주세요.');
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ownerId, revision, visible]);

  const send = async (command: ApplicationCommand, key: string) => {
    try {
      if ('form' in command) await api.submitCardApplication(command.form, key, ownerId);
      else await api.activateCardApplication(command, key, ownerId);
    } catch (error) {
      if (sessionExpired(error)) onSessionExpired();
      throw error;
    }
  };
  const action = useMemberAction('aqua.card-application.' + ownerId, isCommand, send, refresh);
  const application = snapshot?.application;
  const disabled = !fresh || action.blocked || action.busy || Boolean(action.pending);
  let note = application ? descriptions[application.status] : snapshot?.canApply
    ? '신청할 테스트 카드를 선택해 주세요.'
    : '현재 이 계정에서는 테스트 카드를 신청할 수 없어요.';
  if (application?.status === 'declined' && application.reason === 'DETAILS_REQUIRED') note = '발급사에서 신청 정보의 추가 확인을 요청했어요.';
  if (application?.status === 'issued' && application.form === 'physical') note = '실물카드가 발급됐어요. 발송 후 배송 상태가 표시돼요.';
  return <section className="sa-application" aria-label="테스트 카드 신청" data-testid="card-application">
    <div aria-live="polite" aria-atomic="true">
      <h3 data-testid="application-status">{application ? headings[application.status] : '테스트 카드 신청'}</h3>
      {snapshot && <p>{note}</p>}
    </div>
    {snapshot?.canApply && <fieldset disabled={disabled} className="sa-application-options">
      <legend>카드 종류</legend>
      {(['virtual', 'physical'] as const).map(type => <label key={type}><input type="radio" name="application-form" value={type}
        checked={form === type} onChange={() => setForm(type)} /><span><strong>{type === 'virtual' ? '가상카드' : '실물카드'}</strong><small>{type === 'virtual' ? '앱에서 사용' : '배송 후 사용'}</small></span></label>)}
    </fieldset>}
    {!snapshot && !loadError && <p role="status">신청 상태를 확인하고 있어요.</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {action.message && <p role="status">{action.message}</p>}
    <div className="sa-issuer-actions">
      {action.pending ? <button type="button" className="sa-issuer-button" disabled={action.busy || action.blocked}
        data-testid="application-retry" onClick={() => void action.submit(action.pending!.command)}>이전 요청 다시 확인</button> : <>
        {snapshot?.canApply && <button type="button" className="sa-issuer-button" data-testid="application-submit" disabled={disabled}
          onClick={() => void action.submit({ form })}>카드 신청</button>}
        {application && snapshot?.canActivate && <button type="button" className="sa-issuer-button" data-testid="application-activate" disabled={disabled}
          onClick={() => void action.submit({ applicationId: application.id, expectedVersion: application.version })}>카드 사용 시작</button>}
      </>}
      <button type="button" className="sa-issuer-button secondary" data-testid="application-refresh" disabled={action.busy}
        onClick={refresh}>신청 상태 확인</button>
    </div>
  </section>;
}
