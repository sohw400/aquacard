import { useEffect, useState } from 'react';
import type { ReserveActivityPage } from '../../shared/account-activity';
import ActivityPages from './ActivityPages';
import { api, errorMessage } from './api';

const labels = {
  wallet: { in: '지갑에서 넣기', out: '지갑으로 빼기' },
  card: { in: '카드 승인 잔액 반환', out: '카드 승인에 사용' },
};
const date = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul',
});

export default function ReserveMovementHistory({ owner }: { owner: string }) {
  const [first, setFirst] = useState<ReserveActivityPage | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.reserveHistory(owner, null, controller.signal)
      .then(page => { if (!controller.signal.aborted) setFirst(page); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [owner, attempt]);

  return <section className="sa-reserve-history" aria-label="리저브 이동 내역">
    <h3>리저브 이동 내역</h3>
    {error && <p role="alert">{error} <button type="button" className="sa-secondary" onClick={() => setAttempt(n => n + 1)}>다시 불러오기</button></p>}
    {!first && !error && <p role="status">내역을 불러오고 있어요.</p>}
    {first && <ActivityPages first={first.items} cursor={first.nextCursor} owner={owner} fetchPage={api.reserveHistory}>
      {rows => rows?.length ? <ul>{rows.map(row => <li key={row.id}>
        <div><strong>{labels[row.source][row.direction]}</strong><time dateTime={new Date(row.createdAt).toISOString()}>{date.format(row.createdAt)}</time></div>
        <span>{row.direction === 'in' ? '+' : '−'}{row.amountWon.toLocaleString('ko-KR')}원</span>
      </li>)}</ul> : <p>아직 옮긴 금액이 없어요.</p>}
    </ActivityPages>}
  </section>;
}
