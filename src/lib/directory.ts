/** Fictional Aqua members the demo can send to by tag. Real tag lookup needs the member service. */
export interface Member { tag: string; name: string }

export const MEMBERS: readonly Member[] = [
  { tag: 'minji.k', name: '김민지' },
  { tag: 'junho', name: '박준호' },
  { tag: 'seoyeon_lee', name: '이서연' },
  { tag: 'haneul', name: '정하늘' },
  { tag: 'aqua.coffee', name: '아쿠아커피' },
];

/** Tags are 3 to 20 lowercase letters, digits, dots or underscores; a leading @ is optional. */
export const TAG_PATTERN = /^[a-z0-9._]{3,20}$/;
export const normalizeTag = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
export const findMember = (value: string) => MEMBERS.find((member) => member.tag === normalizeTag(value));
/** Shows the first and last character only, the way a bank confirms a recipient. */
export const maskName = (name: string) => name.length <= 2 ? `${name.charAt(0)}*` : `${name.charAt(0)}${'*'.repeat(name.length - 2)}${name.charAt(name.length - 1)}`;
/** A member's own tag comes from the email's local part until tags can be edited. */
export const ownTag = (email: string) => normalizeTag(email.split('@')[0]).replace(/[^a-z0-9._]/g, '').slice(0, 20) || 'aqua.member';
