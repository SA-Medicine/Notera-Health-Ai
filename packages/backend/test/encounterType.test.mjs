import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEncounterDeterministic, pregnancyEvidence } from '../src/validation/upgrades.js';

// 2026-11-13: Seema's visit 4x15c (ultrasound, ear, thinning hair, "what if I try to go to prenatal?") was filed as a pregnancy visit
const HAIR = 'Why is my hair so thin? Your hemoglobin was fine. B12 is low a bit, lower side of normal. Thyroid is fine. What if I try to go to prenatal? Yeah, that is a good idea. My hearing in my left ear is muffled, can you look in my ear?';

test('"prenatal" vitamins are not a pregnancy visit', () => {
  assert.equal(pregnancyEvidence(HAIR), false);
  assert.equal(pregnancyEvidence('should I take prenatal vitamins for my hair?'), false);
  assert.equal(classifyEncounterDeterministic(HAIR), 'general_primary_care');
});

test('a real pregnancy visit stays a pregnancy visit; a negated one does not', () => {
  assert.equal(classifyEncounterDeterministic('I am 12 weeks pregnant and here for my prenatal visit'), 'pregnancy');
  assert.equal(pregnancyEvidence('she is in her second trimester'), true);
  assert.equal(pregnancyEvidence('prenatal appointment next week'), true);
  assert.equal(pregnancyEvidence('No, I am not pregnant.'), false);
});

test('a B12 injection visit is still filed under anemia, a lab review that mentions B12 is not', () => {
  assert.equal(classifyEncounterDeterministic('you are giving me a B12 shot today and my stool test is fine'), 'anemia');
  assert.equal(classifyEncounterDeterministic(HAIR), 'general_primary_care');
});
