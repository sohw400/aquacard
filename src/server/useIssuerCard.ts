import { useCallback, useEffect, useRef, useState } from 'react';
import type { IssuerCardSnapshot, IssuerCardStatus } from '../../shared/api';
import { ApiError, api } from './api';
import {
  clearIssuerIntent, issuerIntentPrefix, issuerRequestWasRejected, issuerSnapshotDoesNotRegress,
  newIssuerIntentKey, parseIssuerReceipt, parseIssuerSnapshot, readIssuerIntents, storeIssuerIntent,
  type IssuerIntent, type IssuerIntentRead,
} from './issuerIntent';

const FRESH_FOR_MS = 15_000;
const storageMessage = (status: 'unavailable' | 'corrupt') => status === 'unavailable'
  ? '이 브라우저에 요청을 보관할 수 없습니다. 저장 공간 설정을 확인한 뒤 다시 확인해 주세요.'
  : '보관된 카드 요청을 읽지 못했습니다. 새로운 요청을 보내지 않고 기록을 유지하고 있습니다.';
const connected = () => navigator.onLine !== false && document.visibilityState === 'visible';
const terminal = (snapshot: IssuerCardSnapshot | null) => !snapshot?.card?.command || ['succeeded', 'failed'].includes(snapshot.card.command.status);

interface ReadFlight { controller: AbortController; generation: number; sequence: number; promise: Promise<void> }
interface WriteFlight { controller: AbortController; generation: number; intent: IssuerIntent }

export function useIssuerCard(ownerId: string, onSessionExpired: () => void) {
  const [snapshot, setSnapshot] = useState<IssuerCardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [intents, setIntents] = useState<IssuerIntent[]>([]);
  const [storageError, setStorageError] = useState('');
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');
  const [fresh, setFresh] = useState(false);
  const lifecycle = useRef({ ownerId, generation: 0, mounted: false, expired: false });
  const onExpired = useRef(onSessionExpired);
  onExpired.current = onSessionExpired;
  const snapshotRef = useRef<IssuerCardSnapshot | null>(null);
  const savedRef = useRef<IssuerIntentRead>({ status: 'ready', intents: [] });
  const read = useRef<ReadFlight | null>(null);
  const write = useRef<WriteFlight | null>(null);
  const sequence = useRef(0);
  const queuedRead = useRef(false);
  const lastConfirmedRead = useRef(0);
  const barrier = useRef<{ cardId: string; minimumVersion: number; commandId: string; targetStatus: IssuerCardStatus } | 'refresh' | null>(null);
  const freshnessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshLatest = useRef<(queue?: boolean) => Promise<void>>(async () => {});

  const isCurrent = useCallback((generation: number) => lifecycle.current.mounted && !lifecycle.current.expired
    && lifecycle.current.ownerId === ownerId && lifecycle.current.generation === generation, [ownerId]);

  const stale = useCallback(() => {
    lastConfirmedRead.current = 0;
    if (freshnessTimer.current) clearTimeout(freshnessTimer.current);
    setFresh(false);
  }, []);

  const syncSaved = useCallback(() => {
    const current = readIssuerIntents(ownerId);
    savedRef.current = current;
    if (current.status === 'ready') { setIntents(current.intents); setStorageError(''); }
    else { setStorageError(storageMessage(current.status)); }
    return current;
  }, [ownerId]);

  const invalidateRead = useCallback(() => {
    sequence.current++;
    const previous = read.current;
    read.current = null;
    queuedRead.current = false;
    previous?.controller.abort();
    setRefreshing(false);
    stale();
  }, [stale]);

  const expire = useCallback((generation: number) => {
    if (!isCurrent(generation)) return;
    lifecycle.current.expired = true;
    invalidateRead();
    write.current?.controller.abort();
    setSubmitting(false); setLoading(false);
    onExpired.current();
  }, [isCurrent, invalidateRead]);

  const load = useCallback(async (queue = true): Promise<void> => {
    const generation = lifecycle.current.generation;
    if (!isCurrent(generation)) return;
    syncSaved();
    if (!connected()) { stale(); setLoading(false); return; }
    if (write.current) { queuedRead.current = true; return; }
    if (read.current) {
      if (queue) queuedRead.current = true;
      return read.current.promise;
    }
    const flight: ReadFlight = { controller: new AbortController(), generation, sequence: ++sequence.current, promise: Promise.resolve() };
    read.current = flight;
    setRefreshing(true);
    flight.promise = (async () => {
      try {
        const result = parseIssuerSnapshot(await api.issuerCard(ownerId, flight.controller.signal));
        if (!isCurrent(generation) || read.current !== flight || sequence.current !== flight.sequence || flight.controller.signal.aborted) return;
        if (!issuerSnapshotDoesNotRegress(snapshotRef.current, result)) throw new Error('Issuer state regressed.');
        const minimum = barrier.current;
        if (minimum && minimum !== 'refresh' && (!result.card || result.card.id !== minimum.cardId || result.card.version < minimum.minimumVersion)) {
          throw new Error('The issuer acknowledgement is newer than this snapshot.');
        }
        if (minimum && minimum !== 'refresh' && result.card?.version === minimum.minimumVersion
          && (result.card.command?.id !== minimum.commandId || result.card.desiredStatus !== minimum.targetStatus)) {
          throw new Error('The issuer snapshot does not match its acknowledgement.');
        }
        snapshotRef.current = result; setSnapshot(result);
        barrier.current = null; setAwaitingConfirmation(false);
        setReadError('');
        if (terminal(result) && savedRef.current.status === 'ready' && !savedRef.current.intents.length) setNotice('');
        lastConfirmedRead.current = performance.now();
        if (freshnessTimer.current) clearTimeout(freshnessTimer.current);
        setFresh(connected());
        freshnessTimer.current = setTimeout(() => { if (isCurrent(generation)) stale(); }, FRESH_FOR_MS);
      } catch (issue) {
        if (!isCurrent(generation) || read.current !== flight || flight.controller.signal.aborted) return;
        stale();
        if (issue instanceof ApiError && (issue.status === 401 || (issue.status === 409 && issue.code === 'SESSION_CHANGED'))) expire(generation);
        else setReadError('카드 상태를 확인하지 못했습니다. 마지막 확인 상태를 표시하고 있습니다.');
      } finally {
        if (read.current !== flight) return;
        read.current = null;
        const again = queuedRead.current;
        queuedRead.current = false;
        if (isCurrent(generation)) {
          setLoading(false); setRefreshing(false);
          if (again) void refreshLatest.current(false);
        }
      }
    })();
    return flight.promise;
  }, [expire, isCurrent, ownerId, stale, syncSaved]);
  refreshLatest.current = load;

  useEffect(() => {
    const current = lifecycle.current;
    current.ownerId = ownerId; current.generation++; current.mounted = true; current.expired = false;
    snapshotRef.current = null; savedRef.current = { status: 'ready', intents: [] };
    read.current = null; write.current = null; barrier.current = null; queuedRead.current = false;
    setSnapshot(null); setLoading(true); setRefreshing(false); setSubmitting(false); setAwaitingConfirmation(false);
    setIntents([]); setStorageError(''); setReadError(''); setWriteError(''); setNotice(''); stale();
    void load();
    const polling = setInterval(() => { if (connected()) void load(false); }, 5_000);
    const foreground = () => {
      invalidateRead();
      if (connected()) void load();
      else setLoading(false);
    };
    const changedStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(issuerIntentPrefix(ownerId))) return;
      // A second tab may have accepted or completed a command while this tab held an old read.
      invalidateRead(); syncSaved(); void load();
    };
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    window.addEventListener('offline', foreground);
    window.addEventListener('storage', changedStorage);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      current.mounted = false; current.generation++;
      read.current?.controller.abort(); write.current?.controller.abort();
      read.current = null; write.current = null; queuedRead.current = false;
      if (freshnessTimer.current) clearTimeout(freshnessTimer.current);
      clearInterval(polling);
      window.removeEventListener('focus', foreground); window.removeEventListener('online', foreground);
      window.removeEventListener('offline', foreground); window.removeEventListener('storage', changedStorage);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [ownerId, load, invalidateRead, stale, syncSaved]);

  const hasFreshState = () => connected() && lastConfirmedRead.current > 0
    && performance.now() - lastConfirmedRead.current >= 0 && performance.now() - lastConfirmedRead.current < FRESH_FOR_MS;

  async function submit(intent: IssuerIntent) {
    const generation = lifecycle.current.generation;
    if (!isCurrent(generation) || write.current || !hasFreshState() || !snapshotRef.current?.canRequestStatus || barrier.current) return;
    try { storeIssuerIntent(ownerId, intent); }
    catch { syncSaved(); setStorageError(storageMessage('unavailable')); return; }
    const flight: WriteFlight = { controller: new AbortController(), generation, intent };
    write.current = flight;
    invalidateRead();
    barrier.current = 'refresh';
    setAwaitingConfirmation(true); setSubmitting(true); setReadError(''); setWriteError(''); setNotice('');
    syncSaved();
    try {
      const receipt = parseIssuerReceipt(await api.issuerCardStatus({ cardId: intent.cardId, targetStatus: intent.targetStatus,
        expectedVersion: intent.expectedVersion }, intent.key, ownerId, flight.controller.signal), intent);
      if (!isCurrent(generation) || write.current !== flight) return;
      barrier.current = { cardId: receipt.cardId, minimumVersion: receipt.cardVersion, commandId: receipt.id, targetStatus: intent.targetStatus };
      let cleanupError = '';
      try { clearIssuerIntent(ownerId, intent); }
      catch { cleanupError = '요청은 접수됐지만 이 브라우저의 기록을 정리하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'; }
      syncSaved();
      // The record is still readable, so allow a same-key retry after the fresh read.
      // Keep this diagnostic outside storageError: polling must not erase it.
      if (cleanupError) setWriteError(cleanupError);
      setNotice('요청을 접수했습니다. 처리 결과를 확인하고 있습니다.');
    } catch (issue) {
      if (!isCurrent(generation) || write.current !== flight) return;
      if (issue instanceof ApiError && (issue.status === 401 || (issue.status === 409 && issue.code === 'SESSION_CHANGED'))) { expire(generation); return; }
      if (issuerRequestWasRejected(issue)) {
        let cleanupError = '';
        try { clearIssuerIntent(ownerId, intent); }
        catch { cleanupError = '이전 요청 기록을 정리하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'; }
        syncSaved();
        setWriteError(cleanupError || '카드 상태가 변경됐거나 다른 요청을 처리 중입니다. 최신 상태를 확인한 뒤 다시 선택해 주세요.');
      } else {
        setWriteError(issue instanceof ApiError && issue.status === 429
          ? '요청이 많습니다. 잠시 뒤 같은 요청으로 다시 확인해 주세요.'
          : '요청이 접수됐는지 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
      }
    } finally {
      if (write.current !== flight) return;
      write.current = null;
      if (isCurrent(generation)) { setSubmitting(false); void load(); }
    }
  }

  function requestStatus(targetStatus: IssuerCardStatus): void {
    const card = snapshotRef.current?.card;
    if (!isCurrent(lifecycle.current.generation) || write.current || !hasFreshState() || barrier.current || !snapshotRef.current?.canRequestStatus
      || !card || !terminal(snapshotRef.current) || !['active', 'locked'].includes(targetStatus)
      || targetStatus === card.confirmedStatus || card.version >= Number.MAX_SAFE_INTEGER) return;
    const stored = syncSaved();
    if (stored.status !== 'ready' || stored.intents.length) return;
    try {
      const intent: IssuerIntent = { key: newIssuerIntentKey(), cardId: card.id, targetStatus, expectedVersion: card.version, createdAt: Date.now() };
      // submit persists and verifies this exact record before initiating the request.
      void submit(intent);
    } catch { setStorageError('안전한 요청 번호를 만들지 못했습니다. 브라우저 연결 설정을 확인해 주세요.'); }
  }

  function retryIntent(): void {
    if (!isCurrent(lifecycle.current.generation) || write.current || !hasFreshState() || barrier.current || !snapshotRef.current?.canRequestStatus) return;
    const stored = syncSaved();
    if (stored.status === 'ready' && stored.intents.length) void submit(stored.intents[0]);
  }

  const belongs = lifecycle.current.ownerId === ownerId && !lifecycle.current.expired;
  const visibleSnapshot = belongs ? snapshot : null;
  const canChange = Boolean(belongs && fresh && visibleSnapshot?.canRequestStatus && visibleSnapshot.card
    && visibleSnapshot.card.version < Number.MAX_SAFE_INTEGER && !submitting && !awaitingConfirmation
    && !intents.length && !storageError && terminal(visibleSnapshot));
  return { snapshot: visibleSnapshot, loading: belongs ? loading : true, refreshing, submitting, fresh: belongs && fresh,
    awaitingConfirmation, intents, storageError, error: readError || writeError, notice, canChange,
    refresh: () => { void load(); }, requestStatus, retryIntent };
}
