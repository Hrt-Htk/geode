import { assertEquals } from "@std/assert";
import { mapWithConcurrency } from "../../../core/concurrency.ts";

/**
 * Test: bounded concurrency actually happens.
 *
 * Instruments a fake async fn to record concurrent in-flight count;
 * asserts max-in-flight > 1 and ≤ the limit.
 */
Deno.test({
  name: "concurrency - mapWithConcurrency respects the limit and is not serial",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const LIMIT = 4;
    const ITEM_COUNT = 20;

    let maxInFlight = 0;
    let currentInFlight = 0;
    const inFlightHistory: number[] = [];

    const fakeFn = async (i: number): Promise<number> => {
      currentInFlight++;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      inFlightHistory.push(currentInFlight);

      // Simulate variable async latency (10-50ms)
      await new Promise((r) => setTimeout(r, 10 + (i % 5) * 10));

      currentInFlight--;
      return i;
    };

    const results = await mapWithConcurrency(
      Array.from({ length: ITEM_COUNT }, (_, i) => i),
      LIMIT,
      fakeFn,
    );

    // Assert: all results present and in order
    assertEquals(results.length, ITEM_COUNT);
    for (let i = 0; i < ITEM_COUNT; i++) {
      assertEquals(results[i], i);
    }

    // Assert: concurrency was > 1 (not serial) and ≤ limit
    assertEquals(
      maxInFlight,
      LIMIT,
      `expected max in-flight to reach ${LIMIT}, got ${maxInFlight}`,
    );
    assertEquals(
      maxInFlight,
      Math.min(maxInFlight, LIMIT),
      `in-flight (${maxInFlight}) exceeded limit (${LIMIT})`,
    );
  },
});
