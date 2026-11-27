import type { CardDeclineRecord } from '../../shared/account-activity';

const explanations: Record<CardDeclineRecord['reason'], string> = {
  card_locked: '카드가 잠겨 있어요. 카드 관리에서 확인해 주세요.',
  card_unavailable: '사용할 수 있는 카드가 없어요. 카드 발급 상태를 확인해 주세요.',
  email_verification: '이메일 인증이 필요해요. 계정에서 인증을 마쳐 주세요.',
  unavailable: '승인되지 않았어요. 문제가 계속되면 고객지원에 문의해 주세요.',
};
const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });

export default function CardDeclinesPanel({ records }: { records: CardDeclineRecord[] | null }) {
  return <section className="sa-transactions" aria-labelledby="declines-heading">
    <div className="sa-section-heading"><h2 id="declines-heading">카드 승인 거절</h2></div>
    {records === null ? <div className="sa-empty-state">내역을 불러오고 있어요.</div>
      : records.length === 0 ? <div className="sa-empty-state">기록된 승인 거절이 없어요.</div>
      : <ul className="sa-transaction-list">{records.map(row => <li key={row.id}>
        <time dateTime={new Date(row.createdAt).toISOString()}>{date.format(row.createdAt)}</time>
        <p>{explanations[row.reason]}</p></li>)}</ul>}
  </section>;
}
