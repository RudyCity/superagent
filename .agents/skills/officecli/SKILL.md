---
name: officecli
description: Create, analyze, proofread, and modify Office documents (.docx, .xlsx, .pptx) using the officecli CLI tool. Use when the user wants to create, inspect, check formatting, find issues, add charts, or modify Office documents.
---

# officecli

AI-friendly CLI for .docx, .xlsx, .pptx. Single binary, no dependencies, no Office installation needed.

## Install

If `officecli` is not installed:

```bash
# macOS / Linux
curl -fsSL https://d.officecli.ai/install.sh | bash

# Windows (PowerShell)
irm https://d.officecli.ai/install.ps1 | iex
```

Verify with `officecli --version`. If still not found after install, open a new terminal.

---

## Strategy

**L1 (read) → L2 (DOM edit) → L3 (raw XML)**. Always prefer higher layers. Add `--json` for structured output.

**Before doc work, check Specialized Skills** (bottom of this file). Fundraising decks, academic papers, financial models, dashboards, and Morph animations need their own skill loaded first — `load_skill` once, then proceed.

---

## Help System (IMPORTANT)

**When unsure about property names, value formats, or command syntax, ALWAYS run help instead of guessing.** One help query beats guess-fail-retry loops.

`officecli help` ≡ `officecli --help`, and `officecli --help` ≡ `officecli help ` — same content.

```bash
officecli help # All commands + global options + schema entry points
officecli help docx # List all docx elements
officecli help docx paragraph # Full schema: properties, aliases, examples, readbacks
officecli help docx set paragraph # Verb-filtered: only props usable with `set`
officecli help docx paragraph --json # Structured schema (machine-readable)
```

Format aliases: `word`→`docx`, `excel`→`xlsx`, `ppt`/`powerpoint`→`pptx`. Verbs: `add`, `set`, `get`, `query`, `remove`. MCP exposes the same schema via the single `command` string param: `{"command":"help docx paragraph"}` (not a structured `{"format":...,"type":...}` object — the MCP tool has exactly one param, `command`, and passes it through to the CLI verbatim).

---

## Performance: Resident Mode

**Every command auto-starts a resident on first access** (60s idle timeout) — file-lock conflicts are automatically avoided. Explicit `open`/`close` is still recommended for longer sessions (12min idle):
```bash
officecli open report.docx # explicitly keep in memory
officecli set report.docx ... # no file I/O overhead
officecli close report.docx # save and release
```

Opt out of auto-start: `OFFICECLI_NO_AUTO_RESIDENT=1`.

**Flush only at the non-officecli boundary.** officecli's own reads (`get`/`query`/`view`/`dump`) always see your latest edits, so you never need to save mid-workflow. Run `save` (keeps the resident) or `close` (flush + release) only **before a non-officecli program reads the file** — python-docx/openpyxl, Word, a renderer, delivery/upload. (Idle sessions auto-flush within seconds; `OFFICECLI_RESIDENT_FLUSH=each` makes every mutation flush before returning.)

---

## Quick Start

**PPT:**
```bash
officecli create slides.pptx
officecli add slides.pptx / --type slide --prop title="Q4 Report" --prop background=1A1A2E
officecli add slides.pptx '/slide[1]' --type shape --prop text="Revenue grew 25%" --prop x=2cm --prop y=5cm --prop font=Arial --prop size=24 --prop color=FFFFFF
```

**Word:**
```bash
officecli create report.docx
officecli add report.docx /body --type paragraph --prop text="Executive Summary" --prop style=Heading1
officecli add report.docx /body --type paragraph --prop text="Revenue increased by 25% year-over-year."
```

**Excel:**
```bash
officecli create data.xlsx
officecli set data.xlsx /Sheet1/A1 --prop value="Name" --prop bold=true
officecli set data.xlsx /Sheet1/A2 --prop value="Alice"
```

---

## L1: Create, Read & Inspect

```bash
officecli create # Create blank .docx/.xlsx/.pptx (type from extension)
officecli view # outline | stats | issues | text | annotated | html
officecli get --depth N # Get a node and its children [--json]
officecli query # CSS-like query
officecli validate # Validate against OpenXML schema
```

### view modes

| Mode | Description | Useful flags |
|------|-------------|-------------|
| `outline` | Document structure | |
| `stats` | Statistics (pages, words, shapes) | |
| `issues` | Formatting/content/structure problems | `--type format\|content\|structure`, `--limit N` |
| `text` | Plain text extraction | `--start N --end N`, `--max-lines N` |
| `annotated` | Text with formatting annotations | |
| `html` | Static HTML snapshot — same renderer as `watch`, no server needed | `--browser`, `--page N` (docx), `--start N --end N` (pptx) |
| `screenshot` / `svg` / `pdf` / `forms` | PNG via headless browser / SVG (pptx slide) / PDF via exporter plugin / form-fields JSON via format-handler plugin | `-o`, `--screenshot-width/-height`, pptx `--grid N` |

Use `view html` for one-shot snapshots (CI artifacts, archival, diffing); use `watch` when you need live refresh or browser-side click-to-select.
