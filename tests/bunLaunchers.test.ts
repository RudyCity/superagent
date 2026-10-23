import { describe, expect, it } from 'vitest';
import { nativeShim } from '../scripts/repair-bun-global-launcher.js';

describe('global Bun launcher templates', () => {
  const bunExe = 'C:\\Users\\Example User\\.bun\\bin\\bun.exe';

  it('uses the absolute Bun executable in cmd without Node bootstrap', () => {
    const body = nativeShim('.cmd', bunExe);
    expect(body).toContain('SuperAgent Bun-native shim');
    expect(body).toContain('"%BUN_EXE%" "%~dp0node_modules\\superagent\\dist\\cli.js" %*');
    expect(body).not.toMatch(/(?:^|\s)node(?:\.exe)?(?:\s|")/im);
  });

  it('uses Bun in PowerShell with argument forwarding', () => {
    const body = nativeShim('.ps1', bunExe);
    expect(body).toContain("bun.exe");
    expect(body).toContain('& $bunExe $cli @args');
    expect(body).not.toMatch(/&\s+node(?:\.exe)?/i);
  });

  it('converts MSYS paths to Windows before invoking Bun', () => {
    const body = nativeShim('', bunExe);
    expect(body).toContain('cygpath -w');
    expect(body).toContain('exec bun "$cli" "$@"');
    expect(body).not.toMatch(/exec node(?:\.exe)?/i);
  });
});
