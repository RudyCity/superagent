/** Lightweight mmBERT-small tokenizer backend.
 *
 * Uses official Rust tokenizers Node bindings by default (~150 MiB process RSS
 * after loading 256K vocabulary on the Windows/Bun development machine).
 * Has the same token ids as the Python tokenizer used during training on the
 * checked multilingual corpus. Falls back to Transformers.js if the native
 * module cannot load, never downloads tokenizers or logs user input.
 *
 * This does NOT perform classification or tool authorization.
 */
import path from "node:path";

export const SENOPATI_MAX_TOKENS = 96;

export type SenopatiEncoded = {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
};
export type SenopatiLoadedTokenizer = {
  engine: "rust-native" | "transformers-js";
  encode(text: string): Promise<SenopatiEncoded>;
};

const GOLDEN: ReadonlyArray<{ text: string; ids: readonly number[] }> = [
  {
    text: "Halo, apa kabar?",
    ids: [2, 64573, 235269, 15486, 141882, 235336, 1],
  },
  {
    text: "Tolong cari dokumentasi proyek",
    ids: [2, 41723, 808, 38411, 60496, 3283, 105924, 1],
  },
  {
    text: "      newlines\n\n \t multiple\twhitespace",
    ids: [2, 235248, 235248, 235248, 235248, 235248, 888, 5448, 109,
          235248, 226, 6733, 226, 156517, 1],
  },
];

export function toSenopatiEncoding(
  rawIds: readonly number[] | ArrayLike<number>,
  rawMask: readonly number[] | ArrayLike<number>,
): SenopatiEncoded {
  if (rawIds.length !== SENOPATI_MAX_TOKENS ||
      rawMask.length !== SENOPATI_MAX_TOKENS) {
    throw new Error("mmBERT tokenizer returned invalid sequence width");
  }
  const ids = new BigInt64Array(SENOPATI_MAX_TOKENS);
  const mask = new BigInt64Array(SENOPATI_MAX_TOKENS);
  for (let i = 0; i < SENOPATI_MAX_TOKENS; i++) {
    const id = Number(rawIds[i]);
    const flag = Number(rawMask[i]);
    if (!Number.isInteger(id) || id < 0 || id >= 256000 ||
        (flag !== 0 && flag !== 1)) {
      throw new Error("Invalid token id or attention mask");
    }
    ids[i] = BigInt(id);
    mask[i] = BigInt(flag);
  }
  if (ids[0] !== 2n || mask[0] !== 1n || mask[1] !== 1n) {
    throw new Error("Invalid mmBERT special-token or mask prefix");
  }
  const padOffset = Array.from(mask).findIndex(x => x === 0n);
  if (padOffset !== -1) {
    for (let i = padOffset; i < SENOPATI_MAX_TOKENS; i++) {
      if (mask[i] !== 0n || ids[i] !== 0n) {
        throw new Error("Invalid tokenizer right padding");
      }
    }
    if (ids[padOffset - 1] !== 1n) {
      throw new Error("Invalid tokenizer EOS before padding");
    }
  } else if (ids[SENOPATI_MAX_TOKENS - 1] !== 1n) {
    throw new Error("Missing final EOS special token");
  }
  return { inputIds: ids, attentionMask: mask };
}

export async function loadSenopatiTokenizer(
  assetFolder: string,
): Promise<SenopatiLoadedTokenizer> {
  const file = path.join(assetFolder, "tokenizer.json");
  try {
    const module = await import("tokenizers");
    const tokenizer = module.Tokenizer.fromFile(file);
    tokenizer.setTruncation(SENOPATI_MAX_TOKENS);
    tokenizer.setPadding({
      maxLength: SENOPATI_MAX_TOKENS,
      padId: 0,
      padToken: "<pad>",
      direction: "right",
    });
    const encode = async (text: string) => {
      const result = await tokenizer.encode(text);
      return toSenopatiEncoding(result.getIds(), result.getAttentionMask());
    };
    for (const golden of GOLDEN) {
      const output = await encode(golden.text);
      const actual = Array.from(output.inputIds.slice(0, golden.ids.length), Number);
      if (actual.some((value, i) => value !== golden.ids[i])) {
        throw new Error("Rust native tokenizer golden parity mismatch");
      }
    }
    return { engine: "rust-native", encode };
  } catch {
    // Backward compatibility for machines where the platform-specific Rust
    // addon is unavailable. No network access; model remains local.
    const { AutoTokenizer, env } = await import("@huggingface/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const tokenizer = await AutoTokenizer.from_pretrained(assetFolder, {
      local_files_only: true,
    });
    return {
      engine: "transformers-js",
      encode: async (text: string) => {
        const output = await tokenizer(text, {
          padding: "max_length",
          truncation: true,
          max_length: SENOPATI_MAX_TOKENS,
        });
        return toSenopatiEncoding(output.input_ids.data, output.attention_mask.data);
      },
    };
  }
}
