/**
 * @file tests/bun_mock_contract.test.ts
 * @description Bun 1.4.4 `mock()` call/result bookkeeping. The mock keeps the wrapped
 * implementation while recording ordered calls and `{ type: "return", value }` results.
 */
import { expect, mock, test } from "bun:test";

const random = mock((multiplier: number) => multiplier * Math.random());

test("random", async () => {
  const a = random(1);
  const b = random(2);
  const c = random(3);

  expect(random).toHaveBeenCalled();
  expect(random).toHaveBeenCalledTimes(3);
  expect(random.mock.calls).toEqual([[1], [2], [3]]);
  expect(random.mock.results[0]).toEqual({ type: "return", value: a });
  // The wrapped implementation still runs: each result lands in [0, multiplier).
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(1);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(b).toBeLessThan(2);
  expect(c).toBeGreaterThanOrEqual(0);
  expect(c).toBeLessThan(3);
});
