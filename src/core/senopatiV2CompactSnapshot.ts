/**
 * Opt-in compiled cache snapshot API for Senopati V2 shadow models.
 * Untrusted snapshots must be validated by senopatiV2CompactCache.ts
 * before being passed to fromTrustedCompiledSnapshot().
 */
export interface SenopatiV2CompactSnapshot {
  readonly features: readonly string[];
  readonly starts: Uint32Array;
  readonly rowIds: Uint16Array;
  readonly weights: Float64Array;
  readonly norms: Float64Array;
  readonly labels: Uint8Array;
  readonly records: number;
}
