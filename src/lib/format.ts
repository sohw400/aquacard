export const won = (value: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(value);
export const money = (value: number) => `${won(value)}원`;
export const shortDate = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(timestamp);
export const dateLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(timestamp);
export const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;
export const dayLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' }).format(timestamp);
export const timeLabel = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(timestamp);
export const monthDay = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' }).format(timestamp);

/** Final consonants of a last digit read aloud (영, 일, 이, 삼, 사, 오, 육, 칠, 팔, 구), so "아쿠아로 3" takes 으로. */
const DIGIT_FINALS = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0];
const finalConsonant = (word: string) => {
  const last = word.charAt(word.length - 1);
  if (last >= '0' && last <= '9') return DIGIT_FINALS[Number(last)];
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11_171 ? code % 28 : 0;
};
/** The particle alone, for when the word itself is laid out separately. */
export const particle = (word: string, afterConsonant: string, afterVowel: string) => finalConsonant(word) ? afterConsonant : afterVowel;
/** Attaches the particle that fits the last syllable: josa('프리미엄', '을', '를') → '프리미엄을'. */
export const josa = (word: string, afterConsonant: string, afterVowel: string) => `${word}${particle(word, afterConsonant, afterVowel)}`;
/** 로 after a vowel or ㄹ, 으로 otherwise: ro('프리미엄') → '프리미엄으로', ro('스탠다드') → '스탠다드로'. */
export const ro = (word: string) => `${word}${[0, 8].includes(finalConsonant(word)) ? '로' : '으로'}`;
