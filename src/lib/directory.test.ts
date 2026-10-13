import test from 'node:test';
import assert from 'node:assert/strict';
import { findMemberByPhone, formatPhone, initialTag, tagIssue, tagLink } from './directory';
import { josa, ro } from './format';

test('처음 태그는 이메일 앞부분으로 만들고, 겹치거나 규칙에 맞지 않으면 고쳐 쓴다', () => {
  assert.equal(initialTag('Tester@aqua.example'), 'tester');
  assert.equal(initialTag('junho@aqua.example'), 'junho2', '체험용 회원 태그와 겹치면 숫자를 붙인다');
  assert.equal(initialTag('admin@aqua.example'), 'admin2', 'Aqua가 쓰는 이름은 피한다');
  assert.equal(initialTag('jo@aqua.example'), 'member.jo');
  assert.equal(initialTag('1234@aqua.example'), 'member.1234', '숫자만 있는 태그는 만들지 않는다');
  assert.equal(initialTag('kim+card..lee.@aqua.example'), 'kimcard.lee');
  for (const email of ['x@a.example', '__@a.example', 'aqua@a.example', `${'a'.repeat(40)}@a.example`, 'a.very.long.local.part.name@a.example']) {
    assert.equal(tagIssue(initialTag(email)), '', email);
  }
});

test('휴대폰 번호는 번호 전체가 맞을 때만, 번호로 찾기를 켠 회원만 찾는다', () => {
  assert.equal(findMemberByPhone('010-0000-0101')?.tag, 'minji.k');
  assert.equal(findMemberByPhone('01000000101')?.tag, 'minji.k');
  assert.equal(findMemberByPhone('010 0000 0102')?.tag, 'junho');
  assert.equal(findMemberByPhone('0100000'), undefined, '번호 일부로는 찾지 않는다');
  assert.equal(findMemberByPhone('01000000103'), undefined, '번호로 찾기를 끈 회원은 나오지 않는다');
  assert.equal(formatPhone('01000000101'), '010-0000-0101');
  assert.equal(tagLink('minji.k'), 'https://aqua.example/@minji.k');
});

test('숫자로 끝나는 말 뒤에도 읽는 소리에 맞춰 조사를 붙인다', () => {
  assert.equal(ro('물빛로 3'), '물빛로 3으로');
  assert.equal(ro('아쿠아로 1'), '아쿠아로 1로');
  assert.equal(ro('101호'), '101호로');
  assert.equal(josa('010-0000-0101', '을', '를'), '010-0000-0101을');
  assert.equal(josa('@junho2', '을', '를'), '@junho2를');
});
