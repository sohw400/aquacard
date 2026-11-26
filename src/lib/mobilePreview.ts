import { SAMPLE_ADDRESSES } from './address';
import { applyAction, createInitialState } from './engine';
import type { AppState } from './types';

function createIssuedPreview(now = Date.now()): AppState {
  let state = applyAction(createInitialState(now), {
    type: 'COMPLETE_SIGNUP', name: '체험회원', email: 'mobile.preview@example.test',
    passwordHash: '5ed8845e40dfa077fc9e0cf0239e55bca3f9bb5bc9efde734708d302b403b6e0',
    birthDate: '1995-04-12', phone: '01000000000',
    kyc: { idType: 'resident', occupation: '회사원', purpose: '카드 결제', source: '근로소득',
      match: 'face', address: { ...SAMPLE_ADDRESSES[0], detail: '' }, pep: false, evidence: null },
  }, now);
  for (const stage of ['identity', 'plan', 'details', 'review'] as const) {
    state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage, identityVerified: stage !== 'identity' } }, now);
  }
  state = applyAction(state, { type: 'SUBMIT_CARD' }, now);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'approved' } }, now);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'issued', issuedAt: now } }, now);
  state = applyAction(state, { type: 'SET_CARD', card: { ...state.card, stage: 'active' } }, now);

  state = applyAction(state, { type: 'SET_REWARDS_AUTO', enabled: false }, now);
  for (const [merchant, amount] of [['성수서점', 24_800], ['한강커피', 7_500], ['을지로 식당', 36_000]] as const) {
    state = applyAction(state, { type: 'PAY', merchant, amount, channel: 'store' }, now);
    state = applyAction(state, { type: 'CONFIRM_PAYMENT', id: state.payments[0].id }, now);
  }
  return applyAction(state, { type: 'SET_REWARDS_AUTO', enabled: true }, now);
}

export function mobilePreviewScenario(search: string, basePath: string) {
  const scenario = new URLSearchParams(search).get('scenario') === 'issued' ? 'issued' : 'signup';
  return {
    storageKey: `aqua-card:mobile-preview:v1:${basePath}:${scenario}`,
    initialState: scenario === 'issued' ? createIssuedPreview : createInitialState,
  };
}
