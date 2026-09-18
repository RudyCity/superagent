import { SelfDevValidationError } from "./eventValidation.js";
import type { SelfDevEventStore } from "./eventStore.js";
import type { SelfDevBatchResult, SelfDevEventInput, SelfDevRecordResult } from "./types.js";

/** Safe integration boundary: errors never contain original input or driver messages. */
export class SelfDevCollector {
  constructor(private readonly store: SelfDevEventStore) {}
  record(input: SelfDevEventInput): SelfDevRecordResult {
    if (!this.store.isCollectionEnabled()) return { recorded: false, reason: "disabled" };
    try {
      const event = this.store.record(input);
      return event ? { recorded: true, event } : { recorded: false, reason: "disabled" };
    } catch (error) {
      return { recorded: false, reason: error instanceof SelfDevValidationError ? "invalid_input" : "storage_error" };
    }
  }
  recordBatch(inputs: readonly SelfDevEventInput[]): SelfDevBatchResult {
    const length = Array.isArray(inputs) ? inputs.length : 0;
    const skip = (reason: string): SelfDevBatchResult => ({
      recorded: [],
      // Invalid oversized batches get a single batch-level sentinel, not unbounded output.
      skipped: length > this.store.getBatchLimit() || !Array.isArray(inputs)
        ? [{ index: -1, reason }]
        : Array.from({ length }, (_, index) => ({ index, reason })),
    });
    if (!this.store.isCollectionEnabled()) return skip("disabled");
    try { return { recorded: this.store.recordBatch(inputs), skipped: [] }; }
    catch (error) { return skip(error instanceof SelfDevValidationError ? "invalid_input" : "storage_error"); }
  }
}
