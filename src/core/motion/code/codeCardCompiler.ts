import type { MotionLayer, MotionTrack, RectLayer, TextLayer, MotionProject, MotionEdit } from "../schema/types.js";

export interface CodeToken {
  text: string;
  kind: "keyword" | "string" | "comment" | "number" | "type" | "function" | "operator" | "plain";
  color: string;
}

export interface CodeCardOptions {
  code: string;
  filename?: string;
  language?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  startFrame: number;
  endFrame: number;
  typing?: boolean;
  typingDurationFrames?: number;
  accentColor?: string;
  fontSize?: number;
}

const KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var", "function", "return",
  "async", "await", "class", "interface", "type", "new", "if", "else", "for", "while",
  "switch", "case", "break", "try", "catch", "finally", "throw", "def", "fn", "struct",
  "impl", "pub", "use", "mod", "self", "select", "insert", "update", "delete", "where",
]);

const TYPES = new Set([
  "string", "number", "boolean", "any", "void", "Promise", "Array", "Record", "Map", "Set",
  "unknown", "never", "null", "undefined", "true", "false", "int", "float", "bool", "str",
]);

const TOKEN_COLORS: Record<CodeToken["kind"], string> = {
  keyword: "#F43F5E",    // Vivid Rose
  string: "#10B981",     // Emerald green
  number: "#F59E0B",     // Amber gold
  comment: "#64748B",    // Muted slate
  type: "#38BDF8",       // Sky blue
  function: "#A855F7",   // Purple
  operator: "#E2E8F0",   // Crisp silver
  plain: "#F8FAFC",      // Pure light
};

/**
 * Lightweight deterministic code tokenizer for developer terminal showcases.
 */
export function tokenizeCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < line.length) {
    // Comments
    if (line.slice(i, i + 2) === "//" || line[i] === "#") {
      tokens.push({ text: line.slice(i), kind: "comment", color: TOKEN_COLORS.comment });
      break;
    }

    // Strings
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const quote = line[i];
      let end = i + 1;
      while (end < line.length && line[end] !== quote) {
        if (line[end] === "\\" && end + 1 < line.length) end += 2;
        else end++;
      }
      if (end < line.length) end++; // consume closing quote
      const text = line.slice(i, end);
      tokens.push({ text, kind: "string", color: TOKEN_COLORS.string });
      i = end;
      continue;
    }

    // Whitespace
    if (/\s/.test(line[i])) {
      let end = i;
      while (end < line.length && /\s/.test(line[end])) end++;
      tokens.push({ text: line.slice(i, end), kind: "plain", color: TOKEN_COLORS.plain });
      i = end;
      continue;
    }

    // Identifiers and words
    if (/[a-zA-Z_$]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[a-zA-Z0-9_$]/.test(line[end])) end++;
      const word = line.slice(i, end);
      let kind: CodeToken["kind"] = "plain";

      if (KEYWORDS.has(word)) kind = "keyword";
      else if (TYPES.has(word)) kind = "type";
      else if (end < line.length && line[end] === "(") kind = "function";

      tokens.push({ text: word, kind, color: TOKEN_COLORS[kind] });
      i = end;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(line[i])) {
      let end = i;
      while (end < line.length && /[0-9.]/.test(line[end])) end++;
      tokens.push({ text: line.slice(i, end), kind: "number", color: TOKEN_COLORS.number });
      i = end;
      continue;
    }

    // Punctuation & operators
    tokens.push({ text: line[i], kind: "operator", color: TOKEN_COLORS.operator });
    i++;
  }

  return tokens;
}

function cleanKeyframes(
  raw: { frame: number; value: number; easing?: any }[],
  maxAllowedFrame: number,
): { frame: number; value: number; easing?: any }[] {
  const bounded = raw
    .map(k => ({ ...k, frame: Math.max(0, Math.min(maxAllowedFrame, Math.round(k.frame))) }))
    .sort((a, b) => a.frame - b.frame);
  const result: { frame: number; value: number; easing?: any }[] = [];
  for (const k of bounded) {
    if (result.length > 0 && result[result.length - 1].frame === k.frame) {
      result[result.length - 1] = k;
    } else {
      result.push(k);
    }
  }
  return result.length > 0 ? result : [{ frame: 0, value: 0 }];
}

/**
 * Compiles a rich developer Code Card with macOS window chrome, syntax tokenization,
 * and animated character-by-character typing kinetics.
 */
export function compileCodeCardLayers(options: CodeCardOptions): MotionLayer[] {
  const layers: MotionLayer[] = [];
  const {
    code,
    filename = "masterAgent.ts",
    language = "TypeScript",
    x,
    y,
    width,
    height,
    startFrame,
    endFrame: rawEndFrame,
    typing = true,
    typingDurationFrames = 45,
    accentColor = "#38BDF8",
    fontSize = 20,
  } = options;

  const endFrame = Math.max(startFrame + 4, rawEndFrame);

  const visible: MotionTrack = {
    property: "opacity",
    keyframes: cleanKeyframes([
      { frame: 0, value: 0 },
      { frame: startFrame, value: 0 },
      { frame: Math.min(endFrame, startFrame + 4), value: 1, easing: "easeOutExpo" },
      { frame: Math.max(startFrame, endFrame - 4), value: 1 },
      { frame: endFrame, value: 0 },
    ], endFrame),
  };

  const scaleEntry: MotionTrack = {
    property: "scale",
    keyframes: cleanKeyframes([
      { frame: startFrame, value: 0.94, easing: "easeOutExpo" },
      { frame: startFrame + 8, value: 1, easing: "linear" },
      { frame: endFrame, value: 1.018, easing: "easeInOut" },
    ], endFrame),
  };

  // 1. Ambient Glow under Card
  layers.push({
    id: "code-card-glow",
    kind: "rect",
    x: x - 12,
    y: y - 12,
    width: width + 24,
    height: height + 24,
    cornerRadius: 24,
    rotation: 0,
    opacity: 0.08,
    fill: accentColor,
    tracks: [visible, scaleEntry],
  });

  // 2. Main Terminal Card Body
  layers.push({
    id: "code-card-bg",
    kind: "rect",
    x,
    y,
    width,
    height,
    cornerRadius: 18,
    rotation: 0,
    opacity: 0.94,
    fill: "#0B0F19",
    tracks: [visible, scaleEntry],
  });

  // 3. Top Window Titlebar
  const titlebarHeight = 44;
  layers.push({
    id: "code-card-titlebar",
    kind: "rect",
    x,
    y,
    width,
    height: titlebarHeight,
    cornerRadius: 18,
    rotation: 0,
    opacity: 0.8,
    fill: "#111827",
    tracks: [visible, scaleEntry],
  });

  // 4. macOS Traffic Light Window Controls
  const dotY = y + 16;
  const dots = [
    { id: "code-dot-red", fill: "#EF4444", dx: 20 },
    { id: "code-dot-yellow", fill: "#F59E0B", dx: 38 },
    { id: "code-dot-green", fill: "#10B981", dx: 56 },
  ];
  for (const dot of dots) {
    layers.push({
      id: dot.id,
      kind: "rect",
      x: x + dot.dx,
      y: dotY,
      width: 12,
      height: 12,
      cornerRadius: 6,
      rotation: 0,
      opacity: 0.9,
      fill: dot.fill,
      tracks: [visible, scaleEntry],
    });
  }

  // 5. File Path Title
  layers.push({
    id: "code-card-file",
    kind: "text",
    text: filename,
    x: x + 84,
    y: y + 12,
    width: width - 240,
    height: 24,
    rotation: 0,
    opacity: 0.9,
    fill: "#94A3B8",
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    tracks: [visible, scaleEntry],
  });

  // 6. Language Pill Badge
  layers.push({
    id: "code-lang-pill",
    kind: "rect",
    x: x + width - 120,
    y: y + 10,
    width: 96,
    height: 24,
    cornerRadius: 12,
    rotation: 0,
    opacity: 0.15,
    fill: accentColor,
    tracks: [visible, scaleEntry],
  });
  layers.push({
    id: "code-lang-txt",
    kind: "text",
    text: `● ${language.toUpperCase()}`,
    x: x + width - 112,
    y: y + 14,
    width: 80,
    height: 18,
    rotation: 0,
    opacity: 0.95,
    fill: accentColor,
    fontSize: 11,
    fontFamily: "JetBrains Mono",
    tracks: [visible, scaleEntry],
  });

  // 7. Titlebar Divider
  layers.push({
    id: "code-titlebar-div",
    kind: "rect",
    x,
    y: y + titlebarHeight,
    width,
    height: 1,
    rotation: 0,
    opacity: 0.3,
    fill: "#1E293B",
    tracks: [visible],
  });

  // 8. Code Lines Rendering with Optional Sequential Character Reveal (Typing)
  const lines = code.trim().split("\n").slice(0, 10); // max 10 lines for presentation clarity
  const lineHeight = fontSize + 12;
  const codeStartY = y + titlebarHeight + 22;
  const totalChars = lines.reduce((acc, l) => acc + l.length, 0);
  let charCounter = 0;

  for (let l = 0; l < lines.length; l++) {
    const lineText = lines[l];
    const currentLineY = codeStartY + l * lineHeight;
    const lineNumStr = String(l + 1).padStart(2, "0");

    // Line Number
    layers.push({
      id: `code-line-num-${l + 1}`,
      kind: "text",
      text: lineNumStr,
      x: x + 24,
      y: currentLineY,
      width: 32,
      height: lineHeight,
      rotation: 0,
      opacity: 0.4,
      fill: "#64748B",
      fontSize,
      fontFamily: "JetBrains Mono",
      tracks: [visible],
    });

    if (!typing) {
      // Instant display
      layers.push({
        id: `code-line-txt-${l + 1}`,
        kind: "text",
        text: lineText,
        x: x + 72,
        y: currentLineY,
        width: width - 96,
        height: lineHeight,
        rotation: 0,
        opacity: 0.95,
        fill: "#F8FAFC",
        fontSize,
        fontFamily: "JetBrains Mono",
        tracks: [visible],
      });
    } else {
      // Kinetic typing reveal
      const lineStartFrame = startFrame + Math.floor((charCounter / Math.max(1, totalChars)) * typingDurationFrames);
      charCounter += lineText.length;
      const lineEndFrame = startFrame + Math.floor((charCounter / Math.max(1, totalChars)) * typingDurationFrames);

      const typeOpacityKeys = cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: Math.max(0, lineStartFrame - 1), value: 0 },
        { frame: lineStartFrame, value: 1 },
        { frame: endFrame - 2, value: 1 },
        { frame: endFrame, value: 0 },
      ], endFrame);

      layers.push({
        id: `code-line-txt-${l + 1}`,
        kind: "text",
        text: lineText,
        x: x + 72,
        y: currentLineY,
        width: width - 96,
        height: lineHeight,
        rotation: 0,
        opacity: 1,
        fill: "#F8FAFC",
        fontSize,
        fontFamily: "JetBrains Mono",
        tracks: [
          {
            property: "opacity",
            keyframes: typeOpacityKeys,
          },
        ],
      });
    }
  }

  // 9. Blinking Terminal Block Cursor
  const cursorBlinkRaw: { frame: number; value: number }[] = [];
  cursorBlinkRaw.push({ frame: 0, value: 0 });
  if (startFrame > 0) {
    cursorBlinkRaw.push({ frame: startFrame, value: 0 });
  }
  for (let f = startFrame + 1; f < endFrame; f++) {
    // Blinks every 8 frames
    const blink = Math.floor((f - startFrame) / 8) % 2 === 0 ? 0.9 : 0;
    cursorBlinkRaw.push({ frame: f, value: blink });
  }
  cursorBlinkRaw.push({ frame: endFrame, value: 0 });
  const cursorBlinkKeys = cleanKeyframes(cursorBlinkRaw, endFrame);

  const lastLineY = codeStartY + Math.min(lines.length, 9) * lineHeight;
  layers.push({
    id: "code-typing-cursor",
    kind: "rect",
    x: x + 72 + Math.min(width - 120, (lines[lines.length - 1]?.length ?? 0) * (fontSize * 0.62) + 8),
    y: lastLineY + 2,
    width: 10,
    height: fontSize + 2,
    cornerRadius: 2,
    rotation: 0,
    opacity: 0.9,
    fill: accentColor,
    tracks: [
      {
        property: "opacity",
        keyframes: cursorBlinkKeys,
      },
    ],
  });

  return layers;
}
