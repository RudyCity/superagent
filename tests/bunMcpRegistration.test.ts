import { describe, expect, it } from 'vitest';
import { buildSuperagentMcpEntry } from '../src/core/mcp/mcpRegistration.js';

describe('Bun MCP registration', () => {
  it('uses Bun, not Node, including an absolute executable path containing spaces', () => {
    const entry = buildSuperagentMcpEntry('C:/Program Files/Super Agent/dist/cli.js', 'C:/Bun Runtime/bun.exe');
    expect(entry.command).toBe('C:/Bun Runtime/bun.exe');
    expect(entry.args).toEqual(['C:/Program Files/Super Agent/dist/cli.js', '--mcp']);
    expect(entry.env).toEqual({ NODE_ENV: 'production' });
  });
  it('can use Bun from PATH as an explicit fallback', () => {
    expect(buildSuperagentMcpEntry('/opt/agent/dist/cli.js', 'bun').command).toBe('bun');
  });
});
