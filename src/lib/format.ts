export const won = (value: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value);
export const money = (value: number) => `₩${won(value)}`;
export const shortDate = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(timestamp);
export const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;
