/**
 * Compact typed-array Senopati V2 sparse shadow implementation.
 *
 * This is an opt-in observational engine. It retains the reference algorithm's
 * feature traversal / row order / tie breaking and performs no tool routing.
 *
 * The only persistent high-cardinality structures are a feature dictionary
 * (posting offsets) and three typed arrays: posting row IDs, posting weights,
 * and per-row norm / head label IDs. It does not retain a copy of record
 * feature objects. Float64 is intentional for exact Rudy/Bun score parity.
 */
import {
  extractSenopatiV2SparseFeatures, SENOPATI_V2_HEADS,
  type SenopatiV2SparsePayload, type SenopatiV2ShadowPrediction,
  type SenopatiV2ShadowLabels,
} from "./senopatiV2Shadow.js";
import { guardSenopatiV2Shadow } from "./senopatiV2Safety.js";
import { validateSenopatiV2CompactCandidate } from "./senopatiV2CandidateValidation.js";
import type { SenopatiV2CompactSnapshot } from "./senopatiV2CompactSnapshot.js";

type Head = keyof typeof SENOPATI_V2_HEADS;
const HEAD_ORDER: Head[] = ["domain", "intent", "action", "risk", "approval"];
const MAX_FEATURE_POSTINGS = 1_000_000;
const MAX_MESSAGE_LENGTH = 8192;
const MAX_CONTEXT_LENGTH = 512;

export class SenopatiV2CompactShadow {
  private readonly featureIds: Map<string, number>;
  private readonly starts: Uint32Array;
  private readonly rowIds: Uint16Array;
  private readonly weights: Float64Array;
  private readonly norms: Float64Array;
  private readonly labels: Uint8Array;
  private readonly recordCount: number;

  constructor(payload: SenopatiV2SparsePayload) {
    // Validate reference-equivalent invariants directly without materializing
    // a throwaway reference model during loading.
    validateSenopatiV2CompactCandidate(payload);
    const count = payload.records.length;
    this.recordCount = count;
    const frequencies = new Map<string, number>();
    this.norms = new Float64Array(count);
    this.labels = new Uint8Array(count * HEAD_ORDER.length);
    let postings = 0;
    for (let rowId = 0; rowId < count; rowId++) {
      const row = payload.records[rowId];
      let normSquared = 0;
      for (const [feature, value] of Object.entries(row.features)) {
        postings++;
        if (postings > MAX_FEATURE_POSTINGS) throw new Error("Compact shadow feature budget exceeded");
        normSquared += value * value;
        frequencies.set(feature, (frequencies.get(feature) ?? 0) + 1);
      }
      this.norms[rowId] = Math.sqrt(normSquared);
      for (let h = 0; h < HEAD_ORDER.length; h++) {
        const head = HEAD_ORDER[h];
        const labelIndex = (SENOPATI_V2_HEADS[head] as readonly string[]).indexOf(row[head]);
        if (labelIndex < 0) throw new Error("Unknown candidate label");
        this.labels[rowId * HEAD_ORDER.length + h] = labelIndex;
      }
    }
    this.rowIds = new Uint16Array(postings);
    this.weights = new Float64Array(postings);
    // A feature dictionary now stores a small integer instead of an array
    // or JS object containing an offset pair for every feature.
    this.featureIds = new Map<string, number>();
    this.starts = new Uint32Array(frequencies.size + 1);
    let ordinal = 0;
    for (const [feature, length] of frequencies) {
      this.featureIds.set(feature, ordinal);
      this.starts[ordinal + 1] = this.starts[ordinal] + length;
      ordinal++;
    }
    const cursor = this.starts.slice(0, frequencies.size);
    for (let rowId = 0; rowId < count; rowId++) {
      for (const [feature, weight] of Object.entries(payload.records[rowId].features)) {
        const featureId = this.featureIds.get(feature);
        if (featureId === undefined) throw new Error("Missing posting feature ID");
        const pos = cursor[featureId]++;
        this.rowIds[pos] = rowId;
        this.weights[pos] = weight;
      }
    }
    // Do not retain payload, counts, or mutable cursors.
  }

  /**
   * Returns copies of compiled arrays for an explicit, hash-bound cache build.
   * Does not contain the original JSON record-feature objects.
   */
  toCompiledSnapshot(): SenopatiV2CompactSnapshot {
    return {
      features: [...this.featureIds.keys()],
      starts: this.starts.slice(),
      rowIds: this.rowIds.slice(),
      weights: this.weights.slice(),
      norms: this.norms.slice(),
      labels: this.labels.slice(),
      records: this.recordCount,
    };
  }

  /**
   * Call ONLY after external checksum, schema, array and registry SHA validation.
   * Retains own arrays and never shares untrusted mutable buffer memory.
   */
  static fromTrustedCompiledSnapshot(s: SenopatiV2CompactSnapshot): SenopatiV2CompactShadow {
    const instance = Object.create(SenopatiV2CompactShadow.prototype) as SenopatiV2CompactShadow;
    Object.assign(instance, {
      featureIds: new Map(s.features.map((feature, i) => [feature, i])),
      starts: s.starts.slice(),
      rowIds: s.rowIds.slice(),
      weights: s.weights.slice(),
      norms: s.norms.slice(),
      labels: s.labels.slice(),
      recordCount: s.records,
    });
    return instance;
  }

  predict(text: string, context = ""): SenopatiV2ShadowPrediction {
    if (typeof text !== "string" || typeof context !== "string" ||
        text.length > MAX_MESSAGE_LENGTH || context.length > MAX_CONTEXT_LENGTH) {
      throw new Error("Compact shadow input exceeds bounded size");
    }
    const input = context ? `context ${context} message ${text}` : `message ${text}`;
    const query = extractSenopatiV2SparseFeatures(input);
    // Iterate query terms in reference insertion order: identical Float64
    // accumulation and exact scores. No per-record feature objects retained.
    const dots = new Float64Array(this.recordCount);
    const touched = new Uint8Array(this.recordCount);
    const qTerms = Object.entries(query);
    let normSquared = 0;
    for (const [feature, qWeight] of qTerms) {
      normSquared += qWeight * qWeight;
      const featureId = this.featureIds.get(feature);
      if (featureId === undefined) continue;
      for (let pos = this.starts[featureId]; pos < this.starts[featureId + 1]; pos++) {
        const rowId = this.rowIds[pos];
        touched[rowId] = 1;
        dots[rowId] += qWeight * this.weights[pos];
      }
    }
    const qNorm = Math.sqrt(normSquared);
    const best = HEAD_ORDER.map(head =>
      (SENOPATI_V2_HEADS[head] as readonly string[]).map(() => [0, 0]));
    // Iteration in ascending original row order is mandatory for strict
    // tie-breaking parity and for the second-largest class match.
    for (let rowId = 0; rowId < this.recordCount; rowId++) {
      if (!touched[rowId]) continue;
      const sim = dots[rowId] / Math.max(0.00001, qNorm * this.norms[rowId]);
      if (sim <= 0) continue;
      for (let h = 0; h < HEAD_ORDER.length; h++) {
        const pair = best[h][this.labels[rowId * HEAD_ORDER.length + h]];
        if (sim > pair[0]) {
          pair[1] = pair[0];
          pair[0] = sim;
        } else if (sim > pair[1]) {
          pair[1] = sim;
        }
      }
    }
    const labels = {} as SenopatiV2ShadowLabels;
    const relativeScores = {} as Record<Head, number>;
    for (let h = 0; h < HEAD_ORDER.length; h++) {
      const head = HEAD_ORDER[h];
      let bestIndex = 0;
      let bestScore = -1;
      let total = 0;
      for (let i = 0; i < best[h].length; i++) {
        const pair = best[h][i];
        const score = pair[0] + pair[1] * 0.25;
        total += Math.max(0, score);
        if (score > bestScore) {
          bestIndex = i;
          bestScore = score;
        }
      }
      (labels as Record<string, string>)[head] = SENOPATI_V2_HEADS[head][bestIndex];
      relativeScores[head] = total > 0
        ? Math.max(0, bestScore) / total
        : 1 / SENOPATI_V2_HEADS[head].length;
    }
    return {
      labels, relativeScores,
      source: "senopati-v2-sparse-shadow", authorizesExecution: false,
    };
  }

  predictGuarded(text: string, context = ""): SenopatiV2ShadowPrediction {
    return guardSenopatiV2Shadow(this.predict(text, context), text, context);
  }

  get stats() {
    return {
      records: this.recordCount,
      features: this.featureIds.size,
      postings: this.rowIds.length,
      typedArrayBytes: this.rowIds.byteLength + this.weights.byteLength +
        this.norms.byteLength + this.labels.byteLength +
        this.starts.byteLength,
      // Backward compatibility for the compact stats API introduced earlier.
      numericBytes: this.rowIds.byteLength + this.weights.byteLength +
        this.norms.byteLength + this.labels.byteLength +
        this.starts.byteLength,
    };
  }
}
