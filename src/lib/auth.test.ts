import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, maskEmail, maskPhone, passwordIssue } from './auth';

test('비밀번호는 8자 이상 영문·숫자 조합이며 이메일로 솔트한 해시만 남긴다', async () => {
  assert.match(passwordIssue('short1'), /8자 이상/);
  assert.match(passwordIssue('onlyletters'), /영문과 숫자/);
  assert.match(passwordIssue('12345678'), /영문과 숫자/);
  assert.equal(passwordIssue('aqua2026pass'), '');
  const first = await hashPassword('Tester@Aqua.Example', 'aqua2026pass');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await hashPassword(' tester@aqua.example ', 'aqua2026pass'), first, '이메일 대소문자와 공백은 같은 계정으로 본다');
  assert.notEqual(await hashPassword('other@aqua.example', 'aqua2026pass'), first);
  assert.equal(maskEmail('demo@aqua.example'), 'de**@aqua.example');
  assert.equal(maskPhone('01012345678'), '010-****-5678');
});
