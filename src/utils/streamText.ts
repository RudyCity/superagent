/**
 * Incremental streaming display utilities.
 *
 * Streaming responses arrive as many small chunks. Naively reprocessing the
 * entire accumulated buffer on every flush is O(n²) in total work and causes
 * visible UI jank on long responses. This helper processes only the volatile
 * tail of the buffer while treating settled content as immutable.
 */

export interface IncrementalStreamCleaner {
  /** Clean a grown buffer, reusing previously cleaned stable content when safe. */
  clean(buffer: string): string;
  /** Full clean, bypassing the stable-prefix cache (use for final output). */
  cleanFinal(buffer: string): string;
  /** Drop the cached prefix (call when the underlying buffer is discarded). */
  reset(): void;
}

/**
 * Wrap a full-text cleaner with incremental stable-prefix caching.
 *
 * The buffer is conceptually split into two regions at any moment:
 *
 *   [--- settled prefix --- | --- volatile tail ---]
 *
 * The settled prefix ends at the last newline (or position 0 if there is no
 * newline yet). It is cleaned once and then frozen. The volatile tail
 * contains the partial last line and is re-cleaned on every flush.
 *
 * Total work for plain prose is O(n) instead of O(n²) because the prefix is
 * frozen at its first full re-clean and only the new settled bytes (added
 * verbatim since cleaning is identity for prose) and the volatile tail are
 * processed on subsequent calls. Markup-containing settled regions are
 * detected and force a full re-clean of the affected range so multi-line
 * tool-call syntax stays correct.
 */
export function createIncrementalStreamCleaner(
  cleanFull: (text: string) => string,
): IncrementalStreamCleaner {
  // Position in the source buffer that `cachedCleanedPrefix` corresponds to.
  // The prefix is always the cleaned form of `sourceBuffer[0, cachedSourceLength)`.
  let cachedCleanedPrefix = "";
  let cachedSourceLength = 0;
  // The last known "settled" length — i.e. lastNewline + 1 at the time of
  // the last clean. We need this so that when the buffer has not gained a
  // new newline (no new settled content), we still know where the previous
  // snapshot ended.
  let lastSettledEnd = 0;

  return {
    clean(buffer: string): string {
      if (buffer.length < cachedSourceLength) {
        // Buffer shrank (new turn): invalidate defensively.
        cachedCleanedPrefix = "";
        cachedSourceLength = 0;
        lastSettledEnd = 0;
      }
      if (buffer.length === cachedSourceLength) {
        return cachedCleanedPrefix;
      }

      const lastNewline = buffer.lastIndexOf("\n");
      const settledEnd = lastNewline === -1 ? 0 : lastNewline + 1;

      if (settledEnd > lastSettledEnd) {
        // New characters have settled since the previous snapshot.
        const newSettled = buffer.slice(lastSettledEnd, settledEnd);
        if (newSettled.includes("<")) {
          // Markup arrived in the newly settled region: re-clean the whole
          // settled region and re-snapshot. This is the only O(n) operation
          // we perform in a typical prose stream, and it happens at most
          // once per chunk of new settled content.
          cachedCleanedPrefix = cleanFull(buffer.slice(0, settledEnd));
        } else if (cachedSourceLength === lastSettledEnd) {
          // Previous cache already matches `buffer[0, lastSettledEnd)` and
          // contains no markup (we never re-snapshot after plain prose). The
          // new settled chunk is plain prose too, so we can append verbatim.
          cachedCleanedPrefix += newSettled;
        } else {
          // The previous cache was rebuilt after a markup change. Until the
          // next markup event we cannot safely append; the simplest correct
          // choice is to re-snapshot the settled region once more. This
          // case only occurs when text alternates between markup and prose
          // chunks, which is rare in practice.
          cachedCleanedPrefix = cleanFull(buffer.slice(0, settledEnd));
        }
        cachedSourceLength = settledEnd;
        lastSettledEnd = settledEnd;
      }

      // Clean the volatile tail: from the settled boundary to the end.
      // For a prose stream this is just the partial last line (a few chars),
      // so per-flush work is O(tail length) rather than O(buffer length).
      return cachedCleanedPrefix + cleanFull(buffer.slice(lastSettledEnd));
    },

    cleanFinal(buffer: string): string {
      return cleanFull(buffer);
    },

    reset(): void {
      cachedCleanedPrefix = "";
      cachedSourceLength = 0;
      lastSettledEnd = 0;
    },
  };
}
