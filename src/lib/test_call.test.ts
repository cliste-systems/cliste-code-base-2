import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTestCall, primaryTestCalledNumber } from "./test_call.js";

describe("test_call", () => {
  it("detects the primary test line", () => {
    assert.equal(isTestCall("+353749389378"), true);
    assert.equal(isTestCall(primaryTestCalledNumber()), true);
  });

  it("rejects non-test numbers", () => {
    assert.equal(isTestCall("+353871234567"), false);
    assert.equal(isTestCall(""), false);
  });
});
