/**
 * Run independent async jobs with bounded concurrency and stable result order.
 * A rejected job stops new work from being scheduled; in-flight jobs are awaited.
 */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let hasError = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!hasError) {
      if (signal?.aborted) {
        const error = new Error("Operation aborted");
        error.name = "AbortError";
        hasError = true;
        firstError = error;
        return;
      }
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  if (hasError) throw firstError;
  return results;
}
