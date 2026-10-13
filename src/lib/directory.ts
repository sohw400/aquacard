/** Fictional Aqua members the demo can send to by tag, QR, phone number or email. Real lookups need the member service. */
export interface Member {
  tag: string;
  name: string;
  /** Made-up numbers in the 010-0000 block, set only for members who let others find them by phone. */
  phone?: string;
  /** Addresses on the reserved .example domain, set only for members who let others find them by email. */
  email?: string;
}

export const MEMBERS: readonly Member[] = [
  { tag: 'minji.k', name: '김민지', phone: '01000000101', email: 'minji.kim@aqua.example' },
  { tag: 'junho', name: '박준호', phone: '01000000102' },
  { tag: 'seoyeon_lee', name: '이서연' },
  { tag: 'haneul', name: '정하늘', phone: '01000000104', email: 'haneul@aqua.example' },
  { tag: 'aqua.coffee', name: '아쿠아커피', email: 'hello@aqua.example' },
];

/** Tags are 3 to 20 lowercase letters, digits, dots or underscores; a leading @ is optional. */
export const TAG_PATTERN = /^[a-z0-9._]{3,20}$/;
/** Names no member can take, so nobody passes as Aqua itself. */
const RESERVED_TAGS = new Set(['aqua', 'aquacard', 'aqua.card', 'aqua_card', 'admin', 'support', 'help', 'official', 'system']);
export const normalizeTag = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
export const findMember = (value: string) => MEMBERS.find((member) => member.tag === normalizeTag(value));

/** A mobile number typed with or without hyphens and spaces. */
export const PHONE_SEARCH = /^01[016789]\d{7,8}$/;
export const phoneDigits = (value: string) => value.replace(/[\s-]/g, '');
/** Whole numbers only, never part of one, so a lookup cannot be used to browse members. */
export const findMemberByPhone = (value: string) => {
  const digits = phoneDigits(value);
  return PHONE_SEARCH.test(digits) ? MEMBERS.find((member) => member.phone === digits) : undefined;
};
/** Something shaped like a whole email address; lookups never match part of one. */
export const EMAIL_SEARCH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const findMemberByEmail = (value: string) => {
  const email = value.trim().toLowerCase();
  return EMAIL_SEARCH.test(email) ? MEMBERS.find((member) => member.email === email) : undefined;
};
export const formatPhone = (digits: string) => digits.length === 11 ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
  : digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;

/** Why a tag cannot be used, or '' when it is free. */
export function tagIssue(tag: string): string {
  if (!TAG_PATTERN.test(tag)) return '영문 소문자, 숫자, 점(.), 밑줄(_)로 3~20자를 넣어 주세요.';
  if (/^[._]|[._]$/.test(tag) || tag.includes('..')) return '점(.)과 밑줄(_)은 맨 앞과 맨 끝에 쓸 수 없고, 점은 두 번 이어 쓸 수 없어요.';
  if (/^\d+$/.test(tag)) return '숫자만으로는 만들 수 없어요. 휴대폰 번호와 헷갈리지 않게 영문을 넣어 주세요.';
  if (RESERVED_TAGS.has(tag) || findMember(tag)) return '이미 누가 쓰고 있는 태그예요.';
  return '';
}

/** The first tag, from the email's local part, numbered when someone already has it. */
export function initialTag(email: string): string {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '').replace(/\.{2,}/g, '.').replace(/^[._]+|[._]+$/g, '').slice(0, 17);
  if (base.length < 3 || /^\d+$/.test(base)) base = `member.${base}`.replace(/\.$/, '').slice(0, 17);
  for (let count = 1; ; count += 1) {
    const tag = count === 1 ? base : `${base}${count}`;
    if (!tagIssue(tag)) return tag;
  }
}

/** What a member's QR code holds. The reserved .example domain keeps the demo from pointing at a real site. */
export const tagLink = (tag: string) => `https://aqua.example/@${tag}`;

/** Shows the first and last character only, the way a bank confirms a recipient. */
export const maskName = (name: string) => name.length <= 2 ? `${name.charAt(0)}*` : `${name.charAt(0)}${'*'.repeat(name.length - 2)}${name.charAt(name.length - 1)}`;
