/**
 * Map `worker` over `items` with at most `limit` invocations in flight at once.
 * Results are returned in input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  };

  const poolSize = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: poolSize }, runner));
  return results;
}
