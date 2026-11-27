import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { money } from '../lib/format';
import { statementText, statementYears, summarizeYear } from '../lib/statement';
import type { AppState } from '../lib/types';
import './AccountPages.css';
import './WalletActivity.css';

const counted = (bucket: { count: number; won: number }) => bucket.count ? `${bucket.count}건 · ${money(bucket.won)}` : '없음';

/** A year at a glance, a note for tax filing, and the rows to paste into a spreadsheet. */
export default function Statement({ state, now }: { state: AppState; now: number }) {
  const years = statementYears(state, now);
  const [picked, setPicked] = useState<number | null>(null);
  const year = picked !== null && years.includes(picked) ? picked : years[0];
  const summary = summarizeYear(state, year);
  const { text, rows } = statementText(state, year);

  return <div className="page statement-page wallet-ledger" data-testid="page-statement">
    <div className="statement-overview">
      <div className="statement-period">
        <label htmlFor={years.length > 1 ? 'statement-year' : undefined}>조회 연도</label>
        {years.length > 1
          ? <select id="statement-year" value={year} onChange={(event) => setPicked(Number(event.target.value))}>
            {years.map((item) => <option key={item} value={item} data-testid={`statement-year-${item}`}>{item}년</option>)}
          </select>
          : <strong>{year}년</strong>}
      </div>
      <CopyStatement key={year} year={year} rows={rows} text={text} />
    </div>
    {rows > 0 && <>
      <section className="plain-section" aria-labelledby="statement-in">
        <div className="section-title"><h2 id="statement-in">{year}년에 들어온 돈</h2></div>
        <dl className="breakdown plain">
          <div><dt>충전</dt><dd data-testid="statement-deposits">{counted(summary.deposits)}</dd></div>
          <div className="statement-included"><dt>그중 코인을 바꾼 충전</dt><dd data-testid="statement-coin-sales">{counted(summary.coinSales)}</dd></div>
          <div><dt>회원에게 받은 돈</dt><dd data-testid="statement-received">{counted(summary.receivedFromMembers)}</dd></div>
        </dl>
      </section>

      <section className="plain-section" aria-labelledby="statement-out">
        <div className="section-title"><h2 id="statement-out">나간 돈</h2></div>
        <dl className="breakdown plain">
          <div><dt>카드 결제 (환불 뺀 금액)</dt><dd data-testid="statement-card">{counted(summary.cardSpent)}</dd></div>
          <div><dt>회원에게 보낸 돈</dt><dd data-testid="statement-sent">{counted(summary.sentToMembers)}</dd></div>
          <div><dt>지갑 주소로 보낸 돈</dt><dd data-testid="statement-withdrawals">{counted(summary.withdrawals)}</dd></div>
          {summary.withdrawals.fees > 0 && <div className="statement-included"><dt>그중 수수료와 네트워크 비용</dt><dd>{money(summary.withdrawals.fees)}</dd></div>}
          <div><dt>카드 연회비</dt><dd data-testid="statement-fees">{summary.cardFees ? money(summary.cardFees) : '없음'}</dd></div>
        </dl>
      </section>

      <section className="plain-section" aria-labelledby="statement-benefits">
        <div className="section-title"><h2 id="statement-benefits">적립된 리워드</h2></div>
        <dl className="breakdown plain">
          <div><dt>페이백</dt><dd data-testid="statement-payback">{money(summary.payback)}</dd></div>
          <div><dt>리저브 보상</dt><dd data-testid="statement-rewards">{money(summary.reserveRewards)}</dd></div>
        </dl>
      </section>
    </>}

    <section className="plain-section" aria-labelledby="statement-tax">
      <div className="section-title"><h2 id="statement-tax">세금 신고에 쓸 때</h2></div>
      <p className="lead-text">코인을 원화 스테이블로 바꾼 충전은 가상자산을 판 것으로 볼&nbsp;수 있어요. 거래 내역을 복사하면 전환 일시, 코인 수량, 원화 금액을 확인할 수 있어요.</p>
      <p className="small-note">페이백과 리저브 보상을 어떻게 신고할지는 세무 전문가와 확인해 주세요.</p>
    </section>
  </div>;
}

function CopyStatement({ year, rows, text }: { year: number; rows: number; text: string }) {
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  async function copyRows() {
    try { await navigator.clipboard.writeText(text); setCopied('done'); }
    catch { setCopied('failed'); }
  }
  return <div className="statement-export">
    <div className="statement-export-row">
      <p>{rows ? `거래 ${rows.toLocaleString('ko-KR')}건` : '해당 연도에 거래가 없어요.'}</p>
      <button type="button" className="btn small neutral" data-testid="statement-copy" disabled={!rows} onClick={copyRows}>
        <Copy size={16} aria-hidden="true" />내역 복사
      </button>
    </div>
    {rows > 0 && <p className="small-note">복사한 내역은 엑셀이나 구글 시트에 붙여 넣을 수 있어요.</p>}
    {copied === 'done' && <p className="statement-copied" role="status"><Check size={16} aria-hidden="true" />{rows}건을 복사했어요.</p>}
    {copied === 'failed' && <>
      <p className="inline-notice warning" role="alert">복사하지 못했어요. 아래 내용을 모두 선택해 복사해 주세요.</p>
      <textarea className="statement-text" data-testid="statement-text" readOnly rows={6} value={text} aria-label={`${year}년 거래 내역`} onFocus={(event) => event.currentTarget.select()} />
    </>}
  </div>;
}
