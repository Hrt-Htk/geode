/**
 * Bounded-concurrency map: apply `fn` to every item in `items` with at most
 * `limit` concurrent calls.  Returns results in original order.
 *
 * Stdlib-only (no deps): ships to both `core/` and `plugin/`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers: Promise<void>[] = [];

  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (nextIndex < items.length) {
          const idx = nextIndex++;
          results[idx] = await fn(items[idx]);
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}
