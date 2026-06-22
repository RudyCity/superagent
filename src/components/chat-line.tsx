import React from "react";
import { Box, Text } from "ink";
import { formatCompactNumber } from "../utils/text.js";
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

export function renderMarkdown(content: string, themeColor: string = "blue", showCursor: boolean = false): React.ReactNode {
  const rawLines = content.split("\n");

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
              <Text color="green">{l}</Text>
              {showCursor && idx === processedLines.length - 1 && <Text color="green">█</Text>}
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
            parsedElements.push(<Text key={parsedElements.length}>{currentText}</Text>);
            break;
          }

          if (minIdx > 0) {
            parsedElements.push(<Text key={parsedElements.length}>{currentText.slice(0, minIdx)}</Text>);
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
  const lines = content.split("\n");
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
                <Text color="yellow">│    </Text>
                <Text dimColor>{prefix}</Text>
                <Text bold color="green">{toolName}</Text>
                <Text color="cyan">(</Text>
                <Text color="yellow">{remaining}</Text>
                {hasClose && <Text color="cyan">)</Text>}
              </Box>
            );
          }
        }
        return (
          <Box key={idx} flexDirection="row">
            <Text color="yellow">│    </Text>
            <Text bold color="white">{l}</Text>
          </Box>
        );
      })}
    </>
  );
}

export function renderToolEnd(content: string, isError: boolean): React.ReactNode {
  const lines = content.split("\n");
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
function renderNestedChild(child: ChatLine, childIdx: number, isCollapsed: boolean, parentColor: string): React.ReactNode {
  const indent = "│    ";  // Parent's content indent

  if (child.type === "tool_start") {
    const content = child.content.replace(/^⚡ /, "");
    if (isCollapsed) {
      const toolName = content.match(/Detail:\s*(\w+)/)?.[1] || "tool";
      const firstLine = content.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
      const desc = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
      return (
        <Box key={`child-${childIdx}`} flexDirection="column">
          <Text color="yellow">
            {indent}│    <Text bold color="yellow">▶ ⚙️ {desc}</Text><Text dimColor> ({toolName})</Text> <Text dimColor italic>click to expand</Text>
          </Text>
        </Box>
      );
    }
    return (
      <Box key={`child-${childIdx}`} flexDirection="column">
        {content.split("\n").map((l, idx) => (
          <Box key={idx} flexDirection="row">
            <Text color="yellow">{indent}│    </Text>
            {l.includes("Detail:") ? (() => {
              const parts = l.split("Detail:");
              const prefix = parts[0] + "Detail: ";
              const rest = parts[1];
              const openParenIdx = rest.indexOf("(");
              if (openParenIdx !== -1) {
                const tName = rest.slice(0, openParenIdx).trim();
                let remaining = rest.slice(openParenIdx + 1);
                const hasClose = remaining.endsWith(")");
                if (hasClose) remaining = remaining.slice(0, -1);
                return (
                  <>
                    <Text dimColor>{prefix}</Text>
                    <Text bold color="green">{tName}</Text>
                    <Text color="cyan">(</Text>
                    <Text color="yellow">{remaining}</Text>
                    {hasClose && <Text color="cyan">)</Text>}
                  </>
                );
              }
              return <Text bold color="white">{l}</Text>;
            })() : <Text bold color="white">{l}</Text>}
          </Box>
        ))}
      </Box>
    );
  }

  if (child.type === "tool_end") {
    const isError = child.content.startsWith("✗");
    const contentText = child.content.substring(2);
    const themeColor = isError ? "red" : "green";
    if (isCollapsed) {
      const firstLine = contentText.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
      const desc = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
      const icon = isError ? "🔴" : "🟢";
      const status = isError ? "Failed" : "Done";
      return (
        <Box key={`child-${childIdx}`} flexDirection="column">
          <Text color={themeColor}>
            {indent}│    <Text bold color={themeColor}>▶ {icon} {status}:</Text> <Text dimColor>{desc}</Text> <Text dimColor italic>click to expand</Text>
          </Text>
        </Box>
      );
    }
    return (
      <Box key={`child-${childIdx}`} flexDirection="column">
        {contentText.split("\n").map((l, idx) => (
          <Box key={idx} flexDirection="row">
            <Text color={themeColor}>{indent}│    </Text>
            {l.startsWith("Output:") || l.startsWith("Detail:") ? (() => {
              const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
              const rest = l.substring(type.length);
              return (
                <>
                  <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
                  <Text dimColor>{rest}</Text>
                </>
              );
            })() : <Text color={isError ? "white" : "gray"} dimColor={!isError}>{l}</Text>}
          </Box>
        ))}
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
  line,
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
  // Helper: extract tool name from content
  const extractToolName = (content: string): string => {
    const match = content.match(/Detail:\s*(\w+)/);
    return match ? match[1] : "tool";
  };

  // Helper: extract description from content
  const extractDescription = (content: string): string => {
    const firstLine = content.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
    return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
  };

  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      return (
        <Box flexDirection="column">
          <Text color="cyan">
            {isFirst ? "┌" : "├"}───[ <Text bold color="cyan">👤 ACCESS_POINT: USER</Text> ]{lineIndex !== undefined ? <Text dimColor> [#{lineIndex}]</Text> : null}
          </Text>
          {content.split("\n").map((l, idx) => (
            <Box key={idx} flexDirection="row">
              <Text color="cyan">│    </Text>
              <Text>{l}</Text>
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
          <Text color="blue">
            {isFirst ? "┌" : "├"}───[ <Text bold color="blue">✦ COGNITIVE_NODE: SUPERAGENT{modelName ? ` (${modelName})` : ""}</Text><Text dimColor> (▲{formatCompactNumber(tokensUp || 0)} | ▼{formatCompactNumber(tokensDown || 0)})</Text> ]{lineIndex !== undefined ? <Text dimColor> [#{lineIndex}]</Text> : null}
          </Text>
          {renderMarkdown(capped.text, "blue")}
          {capped.truncated && (
            <Box flexDirection="row">
              <Text color="blue">│    </Text>
              <Text color="yellow">... [response panjang dipotong; klik untuk buka scroll view, mouse scroll / ↑↓] ...</Text>
            </Box>
          )}
          {children.length > 0 && children.map((child, childIdx) => {
            const isChildCollapsed = isCollapsibleType(child.type) && !expandedChildren.has(childIdx);
            return renderNestedChild(child, childIdx, isChildCollapsed, "blue");
          })}
          <Box flexDirection="row">
            <Text color="blue">│ </Text>
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
            <Text color="yellow">
              ├───[ <Text bold color="yellow">▶ ⚙️ {desc}</Text><Text dimColor> ({toolName})</Text> ] <Text dimColor italic>click to expand</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="yellow">
            ├───[ <Text bold color="yellow">⚙️ SYSTEM_INVOKING_MODULE</Text> ] <Text dimColor italic>click to collapse</Text>
          </Text>
          {renderToolStart(content)}
          <Box flexDirection="row">
            <Text color="yellow">│ </Text>
          </Box>
        </Box>
      );
    }
    case "tool_end": {
      const isError = line.content.startsWith("✗");
      const contentText = line.content.substring(2);
      const themeColor = isError ? "red" : "green";
      if (isCollapsed) {
        const desc = extractDescription(contentText);
        const icon = isError ? "🔴" : "🟢";
        const status = isError ? "Failed" : "Done";
        return (
          <Box flexDirection="column">
            <Text color={themeColor}>
              ├───[ <Text bold color={themeColor}>▶ {icon} {status}:</Text> <Text dimColor>{desc}</Text> ] <Text dimColor italic>click to expand</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color={themeColor}>
            ├───[ <Text bold color={themeColor}>{isError ? "🔴 SYSTEM_CALL_FAILED" : "🟢 SYSTEM_CALL_SUCCESS"}</Text> ] <Text dimColor italic>click to collapse</Text>
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
              ├───[ <Text bold color="red">▶ 🚨 Error:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>click to expand</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="red">
            ├───[ <Text bold color="red">🚨 ERROR_REPORT</Text> ] <Text dimColor italic>click to collapse</Text>
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
              ├───[ <Text bold color="gray">▶ ℹ️ System:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>click to expand</Text>
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text color="gray">
            ├───[ <Text bold color="gray">ℹ️ SYSTEM_INFO</Text> ] <Text dimColor italic>click to collapse</Text>
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
            ├───[ <Text bold color="gray">COMM_PACKET</Text> ]
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
