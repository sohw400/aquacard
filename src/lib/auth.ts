/** Sign-up and identity-check options. The demo keeps only a password hash in this browser. */
export const OCCUPATIONS = ['회사원', '자영업', '전문직', '공무원', '학생', '주부', '무직', '기타'] as const;
export const PURPOSES = ['카드 결제', '자산 보관', '코인 송금', '투자'] as const;
export const FUND_SOURCES = ['근로소득', '사업소득', '금융소득', '자산 매각', '기타'] as const;
export const CARRIERS = ['SKT', 'KT', 'LG U+', '알뜰폰'] as const;
export const ID_TYPES = { resident: '주민등록증', driver: '운전면허증' } as const;
/** Banks for the 1원 account check. The account only proves identity; no money moves through it. */
export const BANKS = ['KB국민은행', '신한은행', '우리은행', '하나은행', 'NH농협은행', 'IBK기업은행', '카카오뱅크', '토스뱅크', '케이뱅크', 'iM뱅크', '부산은행', '우체국', '새마을금고'] as const;

export function passwordIssue(password: string): string {
  if (password.length < 8) return '비밀번호는 8자 이상이어야 해요.';
  if (password.length > 64) return '비밀번호는 64자 이하로 정해 주세요.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '영문과 숫자를 함께 넣어 주세요.';
  return '';
}

/** Salted with the email so the same password never yields the same stored value twice. */
export async function hashPassword(email: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`aqua:${email.trim().toLowerCase()}:${password}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const maskEmail = (email: string) => {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
};

export const maskPhone = (phone: string) => `${phone.slice(0, 3)}-****-${phone.slice(-4)}`;

export const demoCode = (digits = 6) => String(Math.floor(10 ** (digits - 1) * (1 + 9 * Math.random())));
