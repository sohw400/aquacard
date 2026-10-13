import { useId, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { useModal } from './useModal';
import { searchAddresses } from '../lib/address';
import type { ShippingAddress } from '../lib/types';
import './InternalTransferDialog.css';
import './WalletSheet.css';

/** Road-name search, then the unit, then who receives it: the shape Korean card apps use for delivery. */
export default function AddressSheet({ initial, holder, confirmLabel = '이 주소로 받기', onSave, onClose }: {
  initial: ShippingAddress | null;
  holder: string;
  confirmLabel?: string;
  onSave: (address: ShippingAddress) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Omit<ShippingAddress, 'detail'> | null>(initial ? { zip: initial.zip, road: initial.road } : null);
  const [detail, setDetail] = useState(initial?.detail ?? '');
  useModal(panel, onClose, heading);
  const results = searchAddresses(query);

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet address-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} tabIndex={-1} data-testid="address-sheet">
      <header className="itd-header"><div><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>배송지 입력</h2><p>실물카드는 본인만 받을 수 있습니다.</p></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        <div className="form-field"><label htmlFor={`${id}-query`}>주소 찾기</label>
          <div className="address-search"><Search size={18} aria-hidden="true" /><input id={`${id}-query`} data-testid="address-query" type="search" placeholder="도로명이나 지역 이름" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        </div>
        <ul className="address-results" aria-label="찾은 주소">{results.length ? results.map((item) => {
          const selected = picked?.zip === item.zip && picked.road === item.road;
          return <li key={item.zip}><button type="button" className={selected ? 'selected' : ''} aria-pressed={selected} data-testid={`address-result-${item.zip}`} onClick={() => setPicked(item)}><span><strong>{item.road}</strong><small>우편번호 {item.zip}</small></span>{selected && <Check size={18} strokeWidth={2.6} aria-hidden="true" />}</button></li>;
        }) : <li className="address-empty">찾는 주소가 없습니다. 다른 이름으로 찾아 주세요.</li>}</ul>
        {picked && <div className="form-field"><label htmlFor={`${id}-detail`}>상세 주소</label><input id={`${id}-detail`} data-testid="address-detail" placeholder="동·호수 (없으면 비워 두세요)" maxLength={60} autoComplete="off" value={detail} onChange={(event) => setDetail(event.target.value)} /></div>}
        <dl className="card-sheet-cost"><div><dt>받는 분</dt><dd>{holder} (본인)</dd></div></dl>
        <p className="itd-demo-note">체험에서는 예시 주소만 찾습니다. 실제 집 주소는 넣지 마세요. 출시하면 도로명주소 검색을 연결합니다.</p>
      </div>
      <footer className="itd-footer"><button type="button" className="itd-button itd-primary" data-testid="address-save" disabled={!picked} onClick={() => { if (picked) onSave({ ...picked, detail: detail.trim() }); }}>{confirmLabel}</button></footer>
    </section>
  </div>;
}
