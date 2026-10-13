import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { money } from '../lib/format';
import { statementText, statementYears, summarizeYear } from '../lib/statement';
import type { AppState } from '../lib/types';

const counted = (bucket: { count: number; won: number }) => bucket.count ? `${bucket.count}건 · ${money(bucket.won)}` : '없음';

/** A year at a glance, a note for tax filing, and the rows to paste into a spreadsheet. */
export default function Statement({ state, now }: { state: AppState; now: number }) {
  const years = statementYears(state, now);
  const [picked, setPicked] = useState<number | null>(null);
  const year = picked !== null && years.includes(picked) ? picked : years[0];
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  const summary = summarizeYear(state, year);
  const { text, rows } = statementText(state, year);

  async function copyRows() {
    try { await navigator.clipboard.writeText(text); setCopied('done'); }
    catch { setCopied('failed'); }
  }

  return <div className="page statement-page" data-testid="page-statement">
    {years.length > 1 && <div className="segmented" role="group" aria-label="연도" style={{ gridTemplateColumns: `repeat(${years.length}, minmax(0, 1fr))` }}>
      {years.map((item) => <button type="button" key={item} className={item === year ? 'selected' : ''} aria-pressed={item === year} data-testid={`statement-year-${item}`} onClick={() => { setPicked(item); setCopied(''); }}>{item}년</button>)}
    </div>}

    <section className="plain-section" aria-labelledby="statement-in">
      <div className="section-title"><h2 id="statement-in">{year}년에 들어온 돈</h2></div>
      <dl className="breakdown plain">
        <div><dt>충전</dt><dd data-testid="statement-deposits">{counted(summary.deposits)}</dd></div>
        <div><dt>그중 코인을 바꾼 충전</dt><dd data-testid="statement-coin-sales">{counted(summary.coinSales)}</dd></div>
        <div><dt>회원에게 받은 돈</dt><dd data-testid="statement-received">{counted(summary.receivedFromMembers)}</dd></div>
      </dl>
    </section>

    <section className="plain-section" aria-labelledby="statement-out">
      <div className="section-title"><h2 id="statement-out">나간 돈</h2></div>
      <dl className="breakdown plain">
        <div><dt>카드 결제 (환불 뺀 금액)</dt><dd data-testid="statement-card">{counted(summary.cardSpent)}</dd></div>
        <div><dt>회원에게 보낸 돈</dt><dd data-testid="statement-sent">{counted(summary.sentToMembers)}</dd></div>
        <div><dt>지갑 주소로 보낸 돈</dt><dd data-testid="statement-withdrawals">{counted(summary.withdrawals)}</dd></div>
        {summary.withdrawals.fees > 0 && <div><dt>그중 수수료와 네트워크 비용</dt><dd>{money(summary.withdrawals.fees)}</dd></div>}
        <div><dt>카드 연회비</dt><dd data-testid="statement-fees">{summary.cardFees ? money(summary.cardFees) : '없음'}</dd></div>
      </dl>
    </section>

    <section className="plain-section" aria-labelledby="statement-benefits">
      <div className="section-title"><h2 id="statement-benefits">받은 혜택</h2></div>
      <dl className="breakdown plain">
        <div><dt>페이백</dt><dd data-testid="statement-payback">{money(summary.payback)}</dd></div>
        <div><dt>리저브 보상</dt><dd data-testid="statement-rewards">{money(summary.reserveRewards)}</dd></div>
      </dl>
    </section>

    <section className="plain-section" aria-labelledby="statement-tax">
      <div className="section-title"><h2 id="statement-tax">세금 신고에 쓸 때</h2></div>
      <p className="lead-text">코인을 원화 스테이블로 바꾼 충전은 가상자산을 판 것으로 볼&nbsp;수 있어요. 아래에서 복사하는 내역에 바꾼 날짜, 코인, 수량, 원화 금액이 들어 있어요.</p>
      <p className="small-note">페이백과 리저브 보상을 어떻게 신고할지는 세무 전문가와 확인해 주세요.</p>
    </section>

    <section className="plain-section statement-copy" aria-labelledby="statement-copy">
      <div className="section-title"><h2 id="statement-copy">내역 복사</h2></div>
      <p className="lead-text">{rows ? `${year}년 거래 ${rows}건을 복사해요. 엑셀이나 구글 시트에 붙여넣으면 칸이 나뉘어요.` : `${year}년에는 거래가 없어요.`}</p>
      <button type="button" className="btn neutral block" data-testid="statement-copy" disabled={!rows} onClick={copyRows}><Copy size={18} aria-hidden="true" />내역 복사</button>
      {copied === 'done' && <p className="statement-copied" role="status"><Check size={16} strokeWidth={2.6} aria-hidden="true" />{rows}건을 복사했어요.</p>}
      {copied === 'failed' && <>
        <p className="inline-notice warning" role="alert">복사하지 못했어요. 아래 내용을 모두 선택해 복사해 주세요.</p>
        <textarea className="statement-text" data-testid="statement-text" readOnly rows={6} value={text} aria-label={`${year}년 거래 내역`} onFocus={(event) => event.currentTarget.select()} />
      </>}
    </section>
  </div>;
}
