/**
 * fastcontextTool.ts — FastContext repository explorer tool.
 *
 * Wraps Microsoft's FastContext (https://github.com/microsoft/fastcontext)
 * as a read-only codebase exploration tool. Everything is self-contained
 * inside the project:
 *
 *   bin/python/           — Portable Python 3.12 (embeddable) + pip + deps
 *   vendor/fastcontext/   — FastContext source code (git clone)
 *   src/core/tools/fastcontext_runner.py — Python wrapper
 *
 * All model/provider credentials come from Superagent's JSON config
 * (~/.superagent-r/model-config.json) and are passed as CLI arguments.
 * NO environment variables are used anywhere.
 */
import { Tool } from "./types.js";
export declare const fastcontextTool: Tool;
//# sourceMappingURL=fastcontextTool.d.ts.map