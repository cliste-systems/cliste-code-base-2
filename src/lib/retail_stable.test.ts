import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRetailAskNameOnlyLine,
  buildRetailBakeryOrderAskNameLine,
  buildRetailCallbackConfirmationLine,
  buildRetailCallbackNumberConfirmLine,
  buildRetailStockAskNameLine,
  callerSoundsLikeBakeryCakeOrder,
  callerSoundsLikeStockOrPriceQuestion,
  extractRetailCallerFirstName,
  isTakeCallbackNameValidationError,
} from './retail_stable.js';

describe('retail_stable', () => {
  it('detects stock and price questions', () => {
    assert.equal(callerSoundsLikeStockOrPriceQuestion('Do you have bread in stock?'), true);
    assert.equal(callerSoundsLikeStockOrPriceQuestion('How much is the milk?'), true);
    assert.equal(callerSoundsLikeStockOrPriceQuestion('Are ye open tomorrow?'), false);
  });

  it('detects bakery and garbled cake orders', () => {
    assert.equal(callerSoundsLikeBakeryCakeOrder('Do you do cake orders?'), true);
    assert.equal(callerSoundsLikeBakeryCakeOrder('Can I do a take order please?'), true);
    assert.equal(callerSoundsLikeBakeryCakeOrder('Are ye open tomorrow?'), false);
  });

  it('extracts caller first names', () => {
    assert.equal(extractRetailCallerFirstName('My name is Brandon'), 'Brandon');
    assert.equal(extractRetailCallerFirstName("It's Brendan"), 'Brendan');
    assert.equal(extractRetailCallerFirstName('Brandon', { awaitingName: true }), 'Brandon');
    assert.equal(extractRetailCallerFirstName('thanks', { awaitingName: true }), null);
  });

  it('builds stable retail spoken lines', () => {
    assert.match(buildRetailStockAskNameLine(), /first name/i);
    assert.match(buildRetailAskNameOnlyLine(), /first name/i);
    assert.match(buildRetailCallbackConfirmationLine('Brandon'), /Brandon/);
    assert.match(buildRetailCallbackNumberConfirmLine('+353 87 *** 5938'), /best number to contact you on/i);
  });

  it('detects takeCallbackMessage name validation errors', () => {
    assert.equal(
      isTakeCallbackNameValidationError(
        'Ask for their name first and wait for their answer, then call takeCallbackMessage.',
      ),
      true,
    );
    assert.equal(isTakeCallbackNameValidationError('Message logged for the team.'), false);
  });
});
