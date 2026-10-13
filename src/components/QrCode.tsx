import { useMemo } from 'react';
import { encode } from 'uqr';
import './QrCode.css';

/** Light modules scanners need around the code. */
const QUIET = 4;

/** A QR code drawn as one SVG path. It stays dark on light in both themes because phone cameras read that reliably. */
export default function QrCode({ value, size, label, className = '' }: { value: string; size: number; label: string; className?: string }) {
  const { path, modules } = useMemo(() => {
    const { data, size: count } = encode(value, { ecc: 'M', border: 0 });
    let d = '';
    data.forEach((row, y) => {
      for (let x = 0; x < count;) {
        if (!row[x]) { x += 1; continue; }
        let end = x;
        while (end < count && row[end]) end += 1;
        d += `M${x} ${y}h${end - x}v1h${x - end}z`;
        x = end;
      }
    });
    return { path: d, modules: count };
  }, [value]);
  const box = modules + QUIET * 2;
  return <svg className={`qr-code${className ? ` ${className}` : ''}`} role="img" aria-label={label} width={size} height={size} viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`} shapeRendering="crispEdges">
    <rect x={-QUIET} y={-QUIET} width={box} height={box} className="qr-code-tile" />
    <path d={path} className="qr-code-ink" />
  </svg>;
}
