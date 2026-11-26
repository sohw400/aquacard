import { useId } from 'react';
import type { CustomerAccessSnapshot } from '../../shared/api';

const copy: Record<CustomerAccessSnapshot['status'], { title: string; description: string }> = {
  unverified: { title: '거래 전 확인이 필요합니다', description: '계정 확인이 끝나면 송금과 새 카드 결제를 이용할 수 있습니다. 현재는 잔액과 내역을 확인할 수 있습니다.' },
  pending_review: { title: '계정을 확인하고 있습니다', description: '확인이 끝날 때까지 송금과 새 카드 결제가 제한됩니다. 이미 승인된 결제의 취소와 환불은 계속 처리됩니다.' },
  active: { title: '테스트 거래를 이용할 수 있습니다', description: '계정의 거래 제한이 해제된 상태입니다. 실제 본인확인이나 금융 서비스 이용 승인을 의미하지 않습니다.' },
  restricted: { title: '거래가 제한되어 있습니다', description: '현재 송금과 새 카드 결제, 카드 잠금 해제를 이용할 수 없습니다. 잔액과 내역 확인, 카드 잠금은 가능합니다.' },
  frozen: { title: '계정 거래가 중단되었습니다', description: '현재 송금과 새 카드 결제, 카드 잠금 해제를 이용할 수 없습니다. 이미 승인된 결제의 취소와 환불은 계속 처리됩니다.' },
  closed: { title: '거래 이용이 종료된 계정입니다', description: '새로운 거래를 할 수 없습니다. 기존 내역과 남아 있는 잔액은 계속 확인할 수 있습니다.' },
};

export default function CustomerAccessPanel({ access }: { access: CustomerAccessSnapshot | null }) {
  const titleId = useId();
  const content = access?.status === 'active' && !access.canTransact
    ? { title: '이메일 확인이 필요합니다', description: '가입한 이메일을 확인하면 테스트 거래를 이용할 수 있습니다. 이메일 확인은 실제 본인확인이나 금융 서비스 이용 승인을 의미하지 않습니다.' }
    : access ? copy[access.status] : null;
  return <section className={`sa-access-panel${access?.canTransact ? ' is-active' : ''}`} aria-labelledby={titleId}
    data-testid="customer-access-panel" data-status={access?.status ?? 'loading'}>
    <div aria-live="polite" aria-atomic="true">
      <h2 id={titleId}>{content?.title ?? '계정 상태를 확인하고 있습니다'}</h2>
      <p>{content?.description ?? '현재 상태가 확인되면 이용 가능한 기능을 안내합니다.'}</p>
    </div>
    {access && <span className="sa-access-label">{access.canTransact ? '거래 가능' : '거래 제한'}</span>}
  </section>;
}
