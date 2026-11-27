import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from './api';

type Pending<T> = { key: string; command: T };

/** Persist a member's exact command before sending; a lost response can then be replayed. */
export function useMemberAction<T>(storageName: string, isCommand: (value: unknown) => value is T,
  send: (item: T, key: string) => Promise<unknown>, confirmed: () => void) {
  const [pending, setPending] = useState<Pending<T> | null>(null);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(storageName);
      if (raw) {
        const value = JSON.parse(raw);
        if (!value || typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.key) || !isCommand(value.command)) throw new Error();
        setPending(value);
      }
      setBlocked(false);
    } catch { setMessage('저장된 요청을 확인할 수 없어요. 새 탭에서 계좌 내역을 먼저 확인해 주세요.'); }
    return () => { mounted.current = false; };
  }, [storageName, isCommand]);

  function clearIfCurrent(key: string) {
    const stored = sessionStorage.getItem(storageName);
    if (stored && JSON.parse(stored).key === key) sessionStorage.removeItem(storageName);
  }

  async function submit(command: T) {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setMessage('');
    let item: Pending<T> | null = pending;
    try {
      if (!item) {
        item = { key: crypto.randomUUID(), command };
        const serialized = JSON.stringify(item);
        sessionStorage.setItem(storageName, serialized);
        if (sessionStorage.getItem(storageName) !== serialized) throw new Error();
        setPending(item);
      }
      await send(item.command, item.key);
      clearIfCurrent(item.key);
      if (mounted.current) { setPending(null); setMessage('요청이 반영됐어요.'); confirmed(); }
    } catch (error) {
      // A session change or a gateway error cannot rule out an earlier successful delivery.
      const definite = error instanceof ApiError && [400, 403, 404, 409, 422].includes(error.status)
        && error.code !== 'SESSION_CHANGED' && error.code !== 'IDEMPOTENCY_CONFLICT';
      if (definite) {
        try { if (item) clearIfCurrent(item.key); } catch { /* the key remains safe to replay */ }
        if (mounted.current) { setPending(null); confirmed(); }
      }
      if (mounted.current) setMessage(errorMessage(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { pending, message, busy, blocked, submit };
}
