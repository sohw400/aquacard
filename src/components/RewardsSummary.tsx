import { ChevronRight } from 'lucide-react';
import { money, percent } from '../lib/format';
import { getCashbackSummary } from '../lib/rewards';
import type { AppState } from '../lib/types';

export default function RewardsSummary({ state, onOpen }: { state: AppState; onOpen?: () => void }) {
  const summary = getCashbackSummary(state);
  const usedPercent = Math.min(100, Math.max(0, summary.allocated / summary.cap * 100));
  return <div className="cashback-summary">
    <div className="cashback-heading"><div><h3>이번 달 페이백</h3><p>이번 달 결제 기준 · 환불 조정 반영</p></div><span className="cashback-rate" data-testid="cashback-rate">{percent(summary.rate)}</span>{onOpen && <button className="text-button" aria-label="페이백 상세 보기" onClick={onOpen}>상세 <ChevronRight size={15} /></button>}</div>
    <dl className="cashback-metrics"><div className="cashback-metric main"><dt>확정 페이백</dt><dd data-testid="cashback-confirmed">{money(summary.confirmed)}</dd></div><div className="cashback-metric"><dt>확정 대기</dt><dd data-testid="cashback-pending">{money(summary.pending)}</dd></div><div className="cashback-metric"><dt>남은 월 한도</dt><dd data-testid="cashback-remaining">{money(summary.remaining)}</dd></div></dl>
    <div className="cashback-progress" role="progressbar" aria-label="이번 달 페이백 한도 사용" aria-valuemin={0} aria-valuemax={summary.cap} aria-valuenow={Math.min(summary.cap, summary.allocated)} aria-valuetext={`${money(summary.allocated)} / ${money(summary.cap)}`}><span className="cashback-progress-fill" style={{ width: `${usedPercent}%` }} /></div>
    <div className="cashback-limit"><span>확정·대기 포함</span><span>월 최대 {money(summary.cap)}</span></div>
  </div>;
}
