import { useId } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CustomerAccessSnapshot } from '../../shared/api';

const copy: Record<CustomerAccessSnapshot['status'], { title: string; description: string }> = {
  unverified: { title: '거래 전 계정 확인이 필요해요', description: '계정 심사와 이메일 확인이 끝나면 송금과 카드 결제를 이용할 수 있어요.' },
  pending_review: { title: '계정 심사 중', description: '심사가 끝날 때까지 새 거래가 제한돼요. 기존 결제의 취소와 환불은 계속 처리돼요.' },
  active: { title: '거래 가능', description: '테스트 송금과 카드 결제를 이용할 수 있어요.' },
  restricted: { title: '거래 제한', description: '새 거래와 카드 잠금 해제가 제한돼요. 잔액 조회와 카드 잠금은 가능해요.' },
  frozen: { title: '계정 거래 중단', description: '송금과 새 결제, 카드 잠금 해제가 제한돼요. 기존 결제의 취소와 환불은 계속 처리돼요.' },
  closed: { title: '거래 이용 종료', description: '남은 잔액과 기존 내역을 확인할 수 있어요.' },
};

export default function CustomerAccessPanel({ access, showEmailLink }: { access: CustomerAccessSnapshot | null; showEmailLink: boolean }) {
  const titleId = useId();
  const content = access?.status === 'active' && !access.canTransact
    ? { title: '이메일 확인이 필요해요', description: '가입한 이메일을 확인하면 테스트 거래를 이용할 수 있어요.' }
    : access ? copy[access.status] : null;
  return <section className={`sa-access-panel${access?.canTransact ? ' is-active' : ''}`} aria-labelledby={titleId}
    data-testid="customer-access-panel" data-status={access?.status ?? 'loading'}>
    <div aria-live="polite" aria-atomic="true">
      <h2 id={titleId}>{content?.title ?? '계정 확인 중'}</h2>
      {content && <p>{content.description}</p>}
    </div>
    {showEmailLink && <a href="#account" className="sa-access-link" data-testid="dashboard-verify-email">이메일 확인<ChevronRight size={15} aria-hidden="true" /></a>}
  </section>;
}
