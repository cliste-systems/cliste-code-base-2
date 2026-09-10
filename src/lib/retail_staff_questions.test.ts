import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callerSoundsLikeRetailStaffQuestion } from './retail_staff_questions.js';

describe('retail_staff_questions', () => {
  it('detects direct manager questions', () => {
    assert.equal(callerSoundsLikeRetailStaffQuestion("Who's the store manager?"), true);
    assert.equal(callerSoundsLikeRetailStaffQuestion('Who runs fresh food?'), true);
  });

  it('detects garbled SuperValu / store questions', () => {
    assert.equal(
      callerSoundsLikeRetailStaffQuestion('What server value do you work for?'),
      true,
    );
  });

  it('ignores unrelated questions', () => {
    assert.equal(callerSoundsLikeRetailStaffQuestion('Are you open on Thursday?'), false);
  });
});
