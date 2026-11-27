import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FundingAsset, FundingDirection, FundingInput, FundingStatus, MemberFunding } from '../../shared/funding';
import { getFundingNetworks } from '../lib/movements';
import { api, ApiError, errorMessage } from './api';
import { useMemberAction } from './useMemberAction';
import './FundingPanel.css';

const labels: Record<FundingStatus,string> = {
  quoted:'견적',awaiting:'입금 대기',observed:'네트워크 확인 중',confirmed:'환전 대기',credited:'입금 완료',reorg_review:'재확인 중',
  reversed:'입금 정정',held:'출금 금액 보류',dispatched:'전송 중',unknown:'전송 결과 확인 중',settled:'출금 완료',released:'잔액 복원',cancelled:'취소',
};
const money=(v:number)=>v.toLocaleString('ko-KR')+'원';
const assets:FundingAsset[]=['KRWS','USDC','USDT','BTC','ETH'];
function isFundingCommand(value: unknown): value is FundingInput {
  if (!value || typeof value !== 'object' || !('action' in value)) return false;
  if (value.action === 'quote') {
    return 'direction' in value && (value.direction === 'deposit' || value.direction === 'withdrawal')
      && 'asset' in value && assets.includes(value.asset as FundingAsset) && 'network' in value && typeof value.network === 'string'
      && 'quantity' in value && typeof value.quantity === 'string'
      && (value.direction === 'deposit' || ('destination' in value && typeof value.destination === 'string'));
  }
  return ['accept_deposit', 'accept_withdrawal', 'cancel'].includes(String(value.action)) && 'id' in value && typeof value.id === 'string';
}
export default function FundingPanel({owner,enabled,open,onClose,onRefresh}:{owner:string;enabled:boolean;open:boolean;onClose:()=>void;onRefresh:()=>void}) {
  const storageKey='aqua.server.funding.'+owner;
  const title = useRef<HTMLHeadingElement>(null);
  const [loaded,setLoaded]=useState(false);
  useEffect(() => {
    if (open) { title.current?.focus({ preventScroll: true }); title.current?.scrollIntoView({ block: 'start' }); }
  }, [open]);
  const [items,setItems]=useState<MemberFunding[]>([]);
  const [direction,setDirection]=useState<FundingDirection>('deposit');
  const [asset,setAsset]=useState<FundingAsset>('USDC');
  const [network,setNetwork]=useState('polygon');
  const [quantity,setQuantity]=useState('');
  const [destination,setDestination]=useState('');
  const [notice,setNotice]=useState('');
  const [password,setPassword]=useState('');
  const [reauth, setReauth] = useState<FundingInput | null>(null);
  const [checkingPassword,setCheckingPassword] = useState(false);
  const [revision,setRevision]=useState(0);
  const intent = useMemberAction<FundingInput>(storageKey, isFundingCommand, async (command,key) => {
    try {
      await api.fundingIntent(command,key,owner);
      setReauth(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REAUTHENTICATION_REQUIRED') setReauth(command);
      throw error;
    }
  }, () => { setRevision(value=>value+1); onRefresh(); });
  const { pending } = intent;
  const busy = intent.busy || intent.blocked || checkingPassword;
  useEffect(()=>{
    if (!open) return;
    const controller=new AbortController();
    let loading=false;
    const refresh=async()=>{
      if (loading || document.visibilityState==='hidden') return;
      loading=true;
      try {
        const list=await api.funding(owner,controller.signal);
        if (!controller.signal.aborted) { setItems(list); setLoaded(true); setNotice(''); }
      } catch(error){if(!controller.signal.aborted) setNotice(errorMessage(error));}
      finally {loading=false;}
    };
    void refresh();
    const timer=setInterval(()=>void refresh(),5000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[owner,open,revision]);
  async function verifyWithdrawal() {
    if (!reauth || busy || !password) return;
    setCheckingPassword(true);
    try {
      await api.reauthenticate(password,owner);
      setPassword('');
      await intent.submit(reauth);
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setCheckingPassword(false); }
  }
  function quote() {
    const input:FundingInput={action:'quote',direction,asset,network,quantity};
    if(direction==='withdrawal') input.destination=destination.trim();
    void intent.submit(input);
  }
  return <section className="sa-transactions sa-funding" id="funding-content" hidden={!open} aria-labelledby="funding-title">
    <div className="sa-section-heading"><h2 id="funding-title" ref={title} tabIndex={-1}>코인 입출금</h2>
      <button className="sa-icon-button" type="button" aria-label="코인 입출금 닫기" onClick={() => { setPassword(''); onClose(); }}><X size={19} /></button></div>
    {open&&<div>
      <p className="sa-funding-notice">테스트 전용 지갑이에요. 실제 코인은 보내지 마세요.</p>
      <form onSubmit={e=>{e.preventDefault();quote();}}>
        <label>거래<select value={direction} onChange={e=>{setDirection(e.target.value as FundingDirection);setQuantity('');}}>
          <option value="deposit">코인 입금</option><option value="withdrawal">코인 출금</option></select></label>
        <label>코인<select value={asset} onChange={e=>{const next=e.target.value as FundingAsset;setAsset(next);setNetwork(getFundingNetworks(next)[0].id);setDestination('');}}>
          {assets.map(a=><option key={a}>{a}</option>)}</select></label>
        <label>네트워크<select value={network} onChange={e=>{setNetwork(e.target.value);setDestination('');}}>{getFundingNetworks(asset).map(n=><option key={n.id} value={n.id}>{n.label}</option>)}</select></label>
        <label>{direction==='deposit'?asset+' 수량':'지갑에서 출금할 원화 금액'}<input required value={quantity} inputMode={direction==='deposit'?'decimal':'numeric'}
          onChange={e=>setQuantity(e.target.value)} maxLength={19}/></label>
        {direction==='withdrawal'&&<label>체험용 받는 지갑<input required value={destination} onChange={e=>setDestination(e.target.value)}
          placeholder={'aqua-test:'+network+':my-wallet'} maxLength={80}/></label>}
        <button type="submit" className="sa-primary" disabled={!enabled||busy||!!pending}>견적 보기</button>
      </form>
      {reauth && <div><label>현재 비밀번호<input type="password" autoComplete="current-password" value={password}
        onChange={e=>setPassword(e.target.value)}/></label><button type="button" className="sa-secondary" disabled={busy||!password}
        onClick={()=>void verifyWithdrawal()}>본인 확인 후 출금</button></div>}
      {pending&&<button type="button" className="sa-secondary" disabled={busy} onClick={()=>void intent.submit(pending.command)}>같은 요청으로 결과 확인</button>}
      {(notice || intent.message)&&<p role="status">{notice || intent.message}</p>}
      <h3>최근 입출금</h3>
      {!loaded && !notice && <p role="status">입출금 내역을 확인하고 있어요.</p>}
      {loaded && !items.length && <p className="sa-funding-empty">아직 입출금 내역이 없어요.</p>}
      {items.map(o=><article key={o.id} className="sa-funding-record"><div><strong>{o.asset} {o.direction==='deposit'?'입금':'출금'}</strong><span>{labels[o.status]}</span></div>
        <p className="sa-funding-amount"><span>{o.direction === 'deposit' ? '받을 금액' : '출금 총액'}</span><strong>{money(o.grossWon)}</strong></p><dl>
          <div><dt>{o.direction==='deposit'?'입금 수량':'전송 수량'}</dt><dd>{o.units} {o.asset}</dd></div>
          <div><dt>네트워크</dt><dd>{getFundingNetworks(o.asset).find(n => n.id === o.network)?.label ?? o.network}</dd></div>
          <div><dt>적용 단가</dt><dd>{money(o.priceWon)}</dd></div></dl>
        {o.direction==='withdrawal'&&<p>전환 수수료 {money(o.feeWon)} · 네트워크 비용 {money(o.networkFeeWon)} · 전송분 {money(o.netWon)}</p>}
        {(o.direction==='withdrawal'||o.status!=='quoted')&&<p>체험용 지갑 <code>{o.destination}</code></p>}
        {o.status==='quoted'&&<p>견적 만료 {new Date(o.expiresAt).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul'})} (한국 시간)</p>}
        {o.status==='quoted'&&o.expiresAt>Date.now()&&<button type="button" className="sa-primary" disabled={!enabled||busy||!!pending}
          onClick={()=>void intent.submit({action:o.direction==='deposit'?'accept_deposit':'accept_withdrawal',id:o.id})}>{o.direction==='deposit'?'입금 주소 받기':'출금 금액 보류하기'}</button>}
        {['awaiting','held'].includes(o.status)&&<button type="button" className="sa-secondary" disabled={busy||!!pending} onClick={()=>void intent.submit({action:'cancel',id:o.id})}>요청 취소</button>}
      </article>)}
    </div>}
  </section>;
}
