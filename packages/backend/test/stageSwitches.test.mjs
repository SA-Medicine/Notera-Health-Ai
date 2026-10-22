import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../src/orchestrator/runtimeConfig.js';
import { isLockedKey } from '../src/orchestrator/specLock.js';

const KEYS = ['grounding', 'planSweep', 'attribution', 'adviceLines', 'qualityGuards', 'planJoin', 'conditionGuard'].map((k) => 'stage.' + k);
test('every v2 stage has a boolean switch; all on by default except the condition guard', () => {
  for (const k of KEYS) { assert.ok(REGISTRY[k], k); assert.equal(REGISTRY[k].type, 'boolean'); assert.equal(REGISTRY[k].group, 'Pipeline stages (Style Spec v2)'); }
  for (const k of KEYS.filter((x) => x !== 'stage.conditionGuard')) assert.equal(REGISTRY[k].def(), true, k);
  assert.equal(REGISTRY['stage.conditionGuard'].def(), false);
});
test('the stage switches work while the spec is locked; the spec-shaping settings still do not', () => {
  for (const k of KEYS) assert.equal(isLockedKey(k), false, k);
  assert.equal(isLockedKey('story.enabled'), true); assert.equal(isLockedKey('writer.model'), true); assert.equal(isLockedKey('writer.timeoutMs'), false);
});
