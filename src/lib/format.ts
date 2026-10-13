export const won = (value: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value);
export const money = (value: number) => `${won(value)}원`;
export const shortDate = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(timestamp);
export const dateLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(timestamp);
export const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;
export const dayLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' }).format(timestamp);
export const timeLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(timestamp);
export const monthDay = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(timestamp);
