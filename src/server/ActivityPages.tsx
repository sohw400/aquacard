import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActivityPage } from '../../shared/account-activity';
import { errorMessage } from './api';

interface Props<T> {
  first: T[] | null;
  cursor: string | null;
  owner: string;
  fetchPage: (owner: string, cursor: string, signal: AbortSignal) => Promise<ActivityPage<T>>;
  children: (records: T[] | null) => ReactNode;
}

/** The parent keys this paginator by account and first-page boundary. */
export default function ActivityPages<T>({ first, cursor, owner, fetchPage, children }: Props<T>) {
  const [later, setLater] = useState<T[]>([]);
  const [next, setNext] = useState(cursor);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const flight = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => flight.current?.abort(), []);
  async function more() {
    if (!next || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true); setMessage('');
    try {
      const page = await fetchPage(owner, next, controller.signal);
      if (controller.signal.aborted) return;
      setLater(prior => [...prior, ...page.items]);
      setNext(page.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      flight.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return <>{children(first ? [...first, ...later] : null)}
    {next && <button type="button" className="sa-secondary" disabled={loading} onClick={() => void more()}>{loading ? '불러오는 중' : '이전 내역 더 보기'}</button>}
    {message && <p role="alert">{message}</p>}
  </>;
}
