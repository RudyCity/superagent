import React from "react";
import { Box, Text } from "ink";
import { formatCompactNumber, minimizePathInDescription } from "../utils/text.js";
import type { ChatLine } from "../core/slash-commands.js";
import { capDisplayLines } from "../utils/responseScroll.js";

/** Returns true if the given chat line type supports collapse/expand */
export function isCollapsibleType(type: string): boolean {
  return type === "tool_start" || type === "tool_end" || type === "system" || type === "error";
}

export function truncateStreamDisplay(text: string, maxLines: number, width: number): string {
  const rawLines = text.split("\n");
  let accumulated = 0;
  const resultLines: string[] = [];

  for (let i = rawLines.length - 1; i >= 0; i--) {
    const wrappedCount = Math.max(1, Math.ceil(rawLines[i].length / width));
    if (accumulated + wrappedCount > maxLines) {
      if (resultLines.length === 0) {
        resultLines.unshift(rawLines[i]);
      } else {
        resultLines.unshift("... [older output hidden to fit screen] ...");
      }
      break;
    }
    accumulated += wrappedCount;
    resultLines.unshift(rawLines[i]);
  }
  return resultLines.join("\n");
}

function renderBoldTargetText(text: string): React.ReactNode {
  const regex = /(5\.\s+Struktur\s+Direktori\s+Tools|Struktur\s+Direktori\s+Tools)/gi;
  if (!regex.test(text)) {
    return text;
  }
  regex.lastIndex = 0;
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, index) => {
        if (regex.test(part)) {
          return (
            <Text key={index} bold color="yellow">
              {part}
            </Text>
          );
        }
        return part;
      })}
    </>
  );
}

export function renderMarkdown(content: string, themeColor: string = "blue", showCursor: boolean = false): React.ReactNode {
  const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const rawLines = cleanContent.split("\n");

  // Format markdown tables helper
  function formatMarkdownTable(tableLines: string[]): string[] {
    const rows = tableLines.map(line => {
      const parts = line.split("|");
      if (parts.length >= 2) {
        return parts.slice(1, parts.length - 1).map(cell => cell.trim());
      }
      return [];
    });

    const isSeparatorRow = (row: string[]) => {
      return row.length > 0 && row.every(cell => cell.length > 0 && /^[:-]+$/.test(cell));
    };

    const numCols = Math.max(...rows.map(r => r.length));
    const colWidths = Array(numCols).fill(0);

    rows.forEach((row) => {
      if (isSeparatorRow(row)) return;
      for (let i = 0; i < numCols; i++) {
        const cellText = row[i] || "";
        const cleanText = cellText.replace(/\*\*|`/g, "");
        if (cleanText.length > colWidths[i]) {
          colWidths[i] = cleanText.length;
        }
      }
    });

    return rows.map((row) => {
      if (isSeparatorRow(row)) {
        const separatorCells = colWidths.map(width => "-".repeat(width + 2));
        return "| " + separatorCells.join(" | ") + " |";
      }

      const formattedCells = colWidths.map((width, colIdx) => {
        const cellText = row[colIdx] || "";
        const cleanText = cellText.replace(/\*\*|`/g, "");
        const paddingLength = Math.max(0, width - cleanText.length);
        return cellText + " ".repeat(paddingLength);
      });

      return "| " + formattedCells.join(" | ") + " |";
    });
  }

  const processedLines: { text: string; inCodeBlock: boolean; codeLanguage?: string }[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = trimmed.slice(3).trim();
      processedLines.push({ text: line, inCodeBlock: true, codeLanguage });
      i++;
      continue;
    }

    if (inCodeBlock) {
      processedLines.push({ text: line, inCodeBlock: true });
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < rawLines.length && rawLines[i].trim().startsWith("|") && rawLines[i].trim().endsWith("|")) {
        tableLines.push(rawLines[i]);
        i++;
      }
      const formatted = formatMarkdownTable(tableLines);
      formatted.forEach(fLine => {
        processedLines.push({ text: fLine, inCodeBlock: false });
      });
      continue;
    }

    processedLines.push({ text: line, inCodeBlock: false });
    i++;
  }

  let inCode = false;
  return (
    <>
      {processedLines.map((item, idx) => {
        const l = item.text;
        const trimmed = l.trim();

        if (trimmed.startsWith("```")) {
          inCode = !inCode;
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text color="gray" italic>
                {inCode ? `┌─── [ CODE: ${item.codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]"}
              </Text>
              {showCursor && idx === processedLines.length - 1 && <Text color="gray">█</Text>}
            </Box>
          );
        }

        if (inCode) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    │  </Text>
              <Text color="gray">{l}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text color="gray">█</Text>}
            </Box>
          );
        }

        if (l.startsWith("# ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="yellow">{l.slice(2)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="yellow">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("## ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="cyan">{l.slice(3)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="cyan">█</Text>}
            </Box>
          );
        }
        if (l.startsWith("### ")) {
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color="blue">{l.slice(4)}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text bold color="blue">█</Text>}
            </Box>
          );
        }

        let listPrefix = "";
        let isSysLine = false;
        let remainingText = l;
        if (l.trim().startsWith("[SYS]")) {
          isSysLine = true;
          const sysIndex = l.indexOf("[SYS]");
          listPrefix = l.slice(0, sysIndex);
          remainingText = l.slice(sysIndex + 5);
        } else if (l.trim().startsWith("- ")) {
          const indent = l.indexOf("- ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingText = l.slice(indent + 2);
        } else if (l.trim().startsWith("* ")) {
          const indent = l.indexOf("* ");
          listPrefix = " ".repeat(indent) + "• ";
          remainingText = l.slice(indent + 2);
        } else if (/^\d+\.\s/.test(l.trim())) {
          const match = l.match(/^(\s*)(\d+\.\s)(.*)/);
          if (match) {
            listPrefix = match[1] + match[2];
            remainingText = match[3];
          }
        }

        const parsedElements: React.ReactNode[] = [];
        let currentText = remainingText;

        while (currentText.length > 0) {
          const boldIdx = currentText.indexOf("**");
          const codeIdx = currentText.indexOf("`");
          const linkIdx = currentText.indexOf("[");
          
          // Check for raw URLs (file:///, http://, https://)
          const fileUrlIdx = currentText.indexOf("file://");
          const httpUrlIdx = currentText.indexOf("http://");
          const httpsUrlIdx = currentText.indexOf("https://");
          
          let rawUrlIdx = -1;
          if (fileUrlIdx !== -1) {
            rawUrlIdx = fileUrlIdx;
          }
          if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) {
            rawUrlIdx = httpUrlIdx;
          }
          if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) {
            rawUrlIdx = httpsUrlIdx;
          }

          let minIdx = -1;
          let tokenType: "bold" | "code" | "link" | "rawUrl" | "none" = "none";

          if (boldIdx !== -1) {
            minIdx = boldIdx;
            tokenType = "bold";
          }

          if (codeIdx !== -1 && (minIdx === -1 || codeIdx < minIdx)) {
            minIdx = codeIdx;
            tokenType = "code";
          }

          if (linkIdx !== -1 && (minIdx === -1 || linkIdx < minIdx)) {
            const closeBracketIdx = currentText.indexOf("]", linkIdx);
            if (closeBracketIdx !== -1 && currentText[closeBracketIdx + 1] === "(") {
              const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
              if (closeParenIdx !== -1) {
                minIdx = linkIdx;
                tokenType = "link";
              }
            }
          }

          if (rawUrlIdx !== -1 && (minIdx === -1 || rawUrlIdx < minIdx)) {
            const remainingFromUrl = currentText.slice(rawUrlIdx);
            const match = remainingFromUrl.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
            if (match) {
              minIdx = rawUrlIdx;
              tokenType = "rawUrl";
            }
          }

          if (tokenType === "none" || minIdx === -1) {
            parsedElements.push(<Text key={parsedElements.length}>{renderBoldTargetText(currentText)}</Text>);
            break;
          }

          if (minIdx > 0) {
            parsedElements.push(<Text key={parsedElements.length}>{renderBoldTargetText(currentText.slice(0, minIdx))}</Text>);
          }

          currentText = currentText.slice(minIdx);

          if (tokenType === "bold") {
            const nextBoldIdx = currentText.indexOf("**", 2);
            if (nextBoldIdx !== -1) {
              const boldContent = currentText.slice(2, nextBoldIdx);
              parsedElements.push(<Text key={parsedElements.length} bold color="yellow">{boldContent}</Text>);
              currentText = currentText.slice(nextBoldIdx + 2);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, 2)}</Text>);
              currentText = currentText.slice(2);
            }
          } else if (tokenType === "code") {
            const nextCodeIdx = currentText.indexOf("`", 1);
            if (nextCodeIdx !== -1) {
              const codeContent = currentText.slice(1, nextCodeIdx);
              parsedElements.push(<Text key={parsedElements.length} color="cyan" bold>{codeContent}</Text>);
              currentText = currentText.slice(nextCodeIdx + 1);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, 1)}</Text>);
              currentText = currentText.slice(1);
            }
          } else if (tokenType === "link") {
            const closeBracketIdx = currentText.indexOf("]");
            const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
            const linkText = currentText.slice(1, closeBracketIdx);
            const linkUrl = currentText.slice(closeBracketIdx + 2, closeParenIdx);
            
            const osc8Link = `\u001B]8;;${linkUrl}\u0007${linkText}\u001B]8;;\u0007`;
            parsedElements.push(
              <Text key={parsedElements.length} color="cyan" underline>
                {osc8Link}
              </Text>
            );
            currentText = currentText.slice(closeParenIdx + 1);
          } else if (tokenType === "rawUrl") {
            const match = currentText.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
            if (match) {
              let url = match[0];
              // Strip trailing punctuation if it was just sentence punctuation
              while (url.length > 0 && /[.,;:!?]$/.test(url)) {
                url = url.slice(0, -1);
              }
              const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
              parsedElements.push(
                <Text key={parsedElements.length} color="cyan" underline>
                  {osc8Link}
                </Text>
              );
              currentText = currentText.slice(url.length);
            } else {
              parsedElements.push(<Text key={parsedElements.length}>{currentText[0]}</Text>);
              currentText = currentText.slice(1);
            }
          }
        }

        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│    </Text>
            {isSysLine ? (
              <Text>
                {listPrefix}
                <Text bold color="yellow">[SYS]</Text>
              </Text>
            ) : listPrefix ? (
              <Text color="blue" bold>{listPrefix}</Text>
            ) : null}
            <Box flexShrink={1}>
              <Text>
                {parsedElements}
                {showCursor && idx === processedLines.length - 1 && "█"}
              </Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
}

export function renderToolStart(content: string): React.ReactNode {
  const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const lines = cleanContent.split("\n");
  return (
    <>
      {lines.map((l, idx) => {
        if (l.includes("Detail:")) {
          const parts = l.split("Detail:");
          const prefix = parts[0] + "Detail: ";
          const rest = parts[1];
          const openParenIdx = rest.indexOf("(");
          if (openParenIdx !== -1) {
            const toolName = rest.slice(0, openParenIdx).trim();
            let remaining = rest.slice(openParenIdx + 1);
            let hasClose = false;
            if (remaining.endsWith(")")) {
              remaining = remaining.slice(0, -1);
              hasClose = true;
            }
            return (
              <Box key={idx} flexDirection="row">
                <Text color="gray">│    </Text>
                <Text dimColor>{prefix}</Text>
                <Text bold color="green">{toolName}</Text>
                <Text color="cyan">(</Text>
                <Text color="gray">{remaining}</Text>
                {hasClose && <Text color="cyan">)</Text>}
              </Box>
            );
          }
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color="gray">│    </Text>
            <Text bold color="white">{l}</Text>
          </Box>
        );
      })}
    </>
  );
}

export function renderToolEnd(content: string, isError: boolean): React.ReactNode {
  const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const lines = cleanContent.split("\n");
  const themeColor = isError ? "red" : "green";
  return (
    <>
      {lines.map((l, idx) => {
        if (l.startsWith("Output:") || l.startsWith("Detail:")) {
          const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
          const rest = l.substring(type.length);
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>│    </Text>
              <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
              <Text dimColor>{rest}</Text>
            </Box>
          );
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>│    </Text>
            <Text color={isError ? "white" : "gray"} dimColor={!isError}>{l}</Text>
          </Box>
        );
      })}
    </>
  );
}

/** Render a nested child line with extra indentation under a parent */
function renderNestedChild(rawChild: ChatLine, childIdx: number, isCollapsed: boolean, parentColor: string): React.ReactNode {
  const indent = "│        ";  // Parent's content indent + 4 spaces
  const child = {
    ...rawChild,
    content: rawChild.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
  };

   if (child.type === "tool_start") {
    const content = child.content.replace(/^[⚡📖] /, "");
    const firstLine = content.split("\n")[0];
    const cleanDescRaw = firstLine.replace(/^Detail:\s*/i, "").trim();
    const minimizedDesc = minimizePathInDescription(cleanDescRaw);
    const cleanDesc = minimizedDesc.length > 60 ? minimizedDesc.slice(0, 57) + "..." : minimizedDesc;
    const isAskQuestion = cleanDescRaw.startsWith("Asking user:");
    const questionText = isAskQuestion ? cleanDescRaw.replace(/^Asking user:\s*/i, "").trim() : "";
    const merged = child.mergedResult;

    if (isCollapsed) {
      // ── Collapsed with merged result (tool completed) ──────────────
      if (merged) {
        const statusIcon = merged.isError ? "✗" : "✓";
        const statusLabel = merged.isError ? "failed" : "done";
        const statusColor = merged.isError ? "red" : "gray";
        const mergedDesc = minimizePathInDescription(merged.description);
        const displayDesc = mergedDesc.length > 55 ? mergedDesc.slice(0, 52) + "..." : mergedDesc;
        if (isAskQuestion) {
          // For ask_question, show question + answer inline
          const outputLine = merged.content.split("\n").find(l => l.startsWith("Output:"));
          const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
          return (
            <Box key={`child-${childIdx}`} flexDirection="column">
              <Text color={statusColor}>
                {indent}<Text bold color={statusColor}>{statusIcon} ❓ </Text><Text color="yellow">{questionText}</Text><Text bold color={statusColor}> → </Text><Text color={statusColor}>{answerText || "N/A"}</Text> <Text dimColor italic>(Ctrl+O)</Text>
              </Text>
            </Box>
          );
        }
        const diffMatch = merged.content.match(/\+(\d+)\s+-(\d+)/);
        const diffStats = diffMatch
          ? { added: parseInt(diffMatch[1], 10), removed: parseInt(diffMatch[2], 10) }
          : null;
        return (
          <Box key={`child-${childIdx}`} flexDirection="column">
            <Text color="gray">
              {indent}<Text bold color="gray">↳ </Text><Text color="gray">{displayDesc}</Text>
              {diffStats && diffStats.added === 0 && diffStats.removed === 0 ? null : diffStats ? (
                <Text>
                  <Text bold color="green"> +{diffStats.added}</Text>
                  <Text bold color="red"> -{diffStats.removed}</Text>
                </Text>
              ) : null}
              <Text bold color={statusColor}> {statusIcon} {statusLabel}</Text>
              <Text dimColor italic>  (Ctrl+O)</Text>
            </Text>
          </Box>
        );
      }
      // ── Collapsed, tool still running ────────────────────────────
      return (
        <Box key={`child-${childIdx}`} flexDirection="column">
          {isAskQuestion ? (
            <Text color="yellow">
              {indent}<Text bold color="yellow">↳ ❓ Question: </Text><Text color="yellow">{questionText}</Text>
            </Text>
          ) : (
            <Text color="gray">
              {indent}<Text bold color="gray">↳ </Text><Text color="gray">{cleanDesc}</Text> <Text dimColor italic>(Ctrl+O)</Text>
            </Text>
          )}
        </Box>
      );
    }

    // ── Expanded view: Input block + divider + Output block ──────────
    const inputLines = content.split("\n");
    const mergedOutputLines = merged ? merged.content.split("\n") : [];
    const mergedColor = merged?.isError ? "red" : "gray";
    const mergedIcon = merged?.isError ? "✗" : "✓";

    const expandedDiffMatch = merged ? merged.content.match(/\+(\d+)\s+-(\d+)/) : null;
    const expandedDiffStats = expandedDiffMatch
      ? { added: parseInt(expandedDiffMatch[1], 10), removed: parseInt(expandedDiffMatch[2], 10) }
      : null;

    return (
      <Box key={`child-${childIdx}`} flexDirection="column">
        {/* Header */}
        <Box flexDirection="row">
          <Text color="gray">
            {indent}{"▼ "}
          </Text>
          <Text color="gray">
            {cleanDesc}
          </Text>
          {merged && (
            <Text bold color={mergedColor}> {mergedIcon}</Text>
          )}
          {expandedDiffStats && !(expandedDiffStats.added === 0 && expandedDiffStats.removed === 0) && (
            <Text>
              <Text bold color="green"> +{expandedDiffStats.added}</Text>
              <Text bold color="red"> -{expandedDiffStats.removed}</Text>
            </Text>
          )}
          <Text dimColor italic> (Ctrl+O)</Text>
        </Box>
        {/* Input lines */}
        {inputLines.map((l, idx) => {
          if (idx === 0) return null; // skip first line (already shown in header)
          return (
            <Box key={`in-${idx}`} flexDirection="row">
              <Text color="gray">{indent}{"    "}</Text>
              <Text bold color="white">{l}</Text>
            </Box>
          );
        })}
        {/* Divider + Output (only when merged result exists) */}
        {merged && (
          <>
            <Box flexDirection="row">
              <Text color={mergedColor}>{indent}{"    "}{"─".repeat(30)}</Text>
            </Box>
            {mergedOutputLines.map((l, idx) => {
              if (l.startsWith("Output:") || l.startsWith("Detail:")) {
                const labelType = l.startsWith("Output:") ? "Output: " : "Detail: ";
                const rest = l.substring(labelType.length);
                return (
                  <Box key={`out-${idx}`} flexDirection="row">
                    <Text color={mergedColor}>{indent}{"    "}</Text>
                    <Text bold color={merged.isError ? "cyan" : "gray"} dimColor={!merged.isError}>{labelType}</Text>
                    <Text dimColor>{rest}</Text>
                  </Box>
                );
              }
              return (
                <Box key={`out-${idx}`} flexDirection="row">
                  <Text color={mergedColor}>{indent}{"    "}</Text>
                  <Text color={merged.isError ? "white" : "gray"} dimColor={!merged.isError}>{l}</Text>
                </Box>
              );
            })}
          </>
        )}
      </Box>
    );
  }

  // tool_end children are no longer produced by new code, but kept for backward compatibility
  // with any persisted chat history that may still have them
  if (child.type === "tool_end") {
    const isError = child.content.startsWith("✗") || child.content.startsWith("🚨");
    const contentText = child.content.substring(2);
    const themeColor = isError ? "red" : "gray";
    const firstLine = contentText.split("\n")[0];
    const cleanDescRaw = firstLine.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();
    const minimizedDesc = minimizePathInDescription(cleanDescRaw);
    const cleanDesc = minimizedDesc.length > 60 ? minimizedDesc.slice(0, 57) + "..." : minimizedDesc;

    const isAskQuestion = cleanDescRaw.startsWith("Asking user:");
    const questionText = isAskQuestion ? cleanDescRaw.replace(/^Asking user:\s*/i, "").trim() : "";

    if (isCollapsed) {
      return (
        <Box key={`child-${childIdx}`} flexDirection="column">
          {isAskQuestion ? (() => {
            const lines = contentText.split("\n");
            const outputLine = lines.find(l => l.startsWith("Output:"));
            const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
            return (
              <Text color={themeColor}>
                {indent}<Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text bold color={themeColor}>Question: </Text><Text color={themeColor}>{questionText}</Text><Text bold color={themeColor}> | Answer: </Text><Text color={themeColor}>{answerText || "N/A"}</Text>
              </Text>
            );
          })() : (
            <Text color={themeColor}>
              {indent}<Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text color={themeColor}>{cleanDesc}</Text> <Text dimColor italic>{isError ? "(click to view error)" : "(click to view output)"}</Text>
            </Text>
          )}
        </Box>
      );
    }
    return (
      <Box key={`child-${childIdx}`} flexDirection="column">
        {contentText.split("\n").map((l, idx) => {
          const isFirstLine = idx === 0;
          const cleanLine = l.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();
          return (
            <Box key={idx} flexDirection="row">
              <Text color={themeColor}>
                {indent}{isFirstLine ? (isError ? "▼ ✗ " : "▼ ✓ ") : "    "}
              </Text>
              {isFirstLine ? (
                <Text color={themeColor}>
                  {cleanLine}
                  <Text dimColor italic> (click to collapse)</Text>
                </Text>
              ) : l.startsWith("Output:") || l.startsWith("Detail:") ? (() => {
                const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
                const rest = l.substring(type.length);
                return (
                  <>
                    <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
                    <Text dimColor>{rest}</Text>
                  </>
                );
              })() : (
                <Text color={isError ? "white" : "gray"} dimColor={!isError}>{l}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Fallback for other child types (system, error)
  return (
    <Box key={`child-${childIdx}`} flexDirection="column">
      {child.content.split("\n").map((l, idx) => (
        <Box key={idx} flexDirection="row">
          <Text color="gray">{indent}│    </Text>
          <Text>{l}</Text>
        </Box>
      ))}
    </Box>
  );
}


interface ChatLineComponentProps {
  line: ChatLine;
  isFirst: boolean;
  lineIndex?: number;  // Index for pinning
  tokensUp?: number;
  tokensDown?: number;
  modelName?: string;
  maxResponseLines?: number;
  chatWidth?: number;
  /** When true, skip truncation for this assistant response (used for the last response) */
  isLastAssistant?: boolean;
  /** When true, render compact collapsed view */
  isCollapsed?: boolean;
  /** Set of expanded child indexes (for nested tool children) */
  expandedChildren?: Set<number>;
  /** Toggle expand/collapse for a child line */
  toggleChildExpand?: (childIndex: number) => void;
}

export const ChatLineComponent = React.memo(function ChatLineComponent({
  line: rawLine,
  isFirst,
  lineIndex,
  tokensUp,
  tokensDown,
  modelName,
  maxResponseLines,
  chatWidth,
  isLastAssistant,
  isCollapsed,
  expandedChildren = new Set(),
  toggleChildExpand,
}: ChatLineComponentProps) {
  const line = React.useMemo(() => {
    return {
      ...rawLine,
      content: rawLine.content.replace(/\r\n/g, "\n").replace(/\r/g, ""),
      children: rawLine.children?.map(child => ({
        ...child,
        content: child.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
      }))
    };
  }, [rawLine]);

  // Helper: extract tool name from content
  const extractToolName = (content: string): string => {
    const match = content.match(/Detail:\s*(\w+)/);
    return match ? match[1] : "tool";
  };

  // Helper: extract description from content
  const extractDescription = (content: string): string => {
    const firstLine = content.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
    const minimized = minimizePathInDescription(firstLine);
    return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
  };

  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      return (
        <Box flexDirection="column">
          <Text color="cyan">
            {isFirst ? "┌" : "├"}─── [ <Text bold color="cyan">👤 ACCESS_POINT: USER</Text> ]{lineIndex !== undefined ? <Text dimColor> [#{lineIndex}]</Text> : null}
          </Text>
          {content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="cyan">│    </Text>
              <Text>{renderBoldTargetText(l)}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="cyan">│ </Text>
          </Box>
        </Box>
      );
    }
    case "assistant": {
      const capped = isLastAssistant
        ? { text: line.content, truncated: false }
        : capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);
      const children = line.children || [];
      return (
        <Box flexDirection="column">
          <Text color="gray">
            {isFirst ? "┌" : "├"}─── [ <Text bold color="gray">✦ SUPERAGENT</Text> ]{lineIndex !== undefined ? <Text color="gray"> [#{lineIndex}]</Text> : null}
          </Text>
          {renderMarkdown(capped.text, "gray")}
          {capped.truncated && (
            <Box flexDirection="row">
              <Text color="gray">│    </Text>
              <Text color="yellow">... [long response truncated; click to open scroll view, mouse scroll / ↑↓] ...</Text>
            </Box>
          )}
          {children.length > 0 && children.map((child, childIdx) => {
            const isChildCollapsed = isCollapsibleType(child.type) && !expandedChildren.has(childIdx);
            return renderNestedChild(child, childIdx, isChildCollapsed, "gray");
          })}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
    }
    case "tool_start": {
      const content = line.content.replace(/^⚡ /, "");
      if (isCollapsed) {
        const toolName = extractToolName(line.content);
        const desc = extractDescription(content);
        return (
          <Box flexDirection="column">
            <Text color="gray">
              ├─── [ <Text bold color="gray">▶ {desc}</Text><Text dimColor> ({toolName})</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├─── [ <Text bold color="gray">SYSTEM_INVOKING_MODULE</Text> ] <Text dimColor italic>Ctrl+O</Text>
          </Text>
          {renderToolStart(content)}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
    }
    case "tool_end": {
      const isError = line.content.startsWith("✗");
      const contentText = line.content.substring(2);
      const themeColor = isError ? "red" : "gray";
      if (isCollapsed) {
        const desc = extractDescription(contentText);
        const icon = isError ? "🔴" : "⚪";
        const status = isError ? "Failed" : "Done";
        return (
          <Box flexDirection="column">
            <Text color={themeColor}>
              ├─── [ <Text bold color={themeColor}>▶ {icon} {status}:</Text> <Text dimColor>{desc}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color={themeColor}>
            ├─── [ <Text bold color={themeColor}>{isError ? "🔴 SYSTEM_CALL_FAILED" : "⚪ SYSTEM_CALL_SUCCESS"}</Text> ] <Text dimColor italic>Ctrl+O</Text>
          </Text>
          {renderToolEnd(contentText, isError)}
          <Box flexDirection="row">
            <Text color={themeColor}>│ </Text>
          </Box>
        </Box>
      );
    }
    case "error": {
      const contentText = line.content.replace(/^Error: /, "");
      if (isCollapsed) {
        const firstLine = contentText.split("\n")[0];
        const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
        return (
          <Box flexDirection="column">
            <Text color="red">
              ├─── [ <Text bold color="red">▶ 🚨 Error:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="red">
            ├─── [ <Text bold color="red">🚨 ERROR_REPORT</Text> ] <Text dimColor italic>Ctrl+O</Text>
          </Text>
          {contentText.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="red">│    </Text>
              <Text color="red">{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="red">│ </Text>
          </Box>
        </Box>
      );
    }
    case "system":
      if (isCollapsed) {
        const firstLine = line.content.split("\n")[0];
        const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
        return (
          <Box flexDirection="column">
            <Text color="gray">
              ├─── [ <Text bold color="gray">▶ ℹ️ System:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├─── [ <Text bold color="gray">ℹ️ SYSTEM_INFO</Text> ] <Text dimColor italic>Ctrl+O</Text>
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│    </Text>
              <Text color="gray" italic>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
    default:
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├─── [ <Text bold color="gray">COMM_PACKET</Text> ]
          </Text>
          {line.content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="gray">│    </Text>
              <Text>{l}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        </Box>
      );
  }
});
