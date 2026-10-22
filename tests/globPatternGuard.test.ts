import { describe, expect, it } from 'vitest';
import { validateGlobPattern } from '../src/core/tools/globPatternGuard.js';
describe('glob input depth guard',()=>{
  it('accepts common recursive and braces globs',()=>{
    expect(validateGlobPattern('src/**/*.{ts,tsx}')).toBe('src/**/*.{ts,tsx}');
    expect(validateGlobPattern('foo/{a,{b,c}}')).toBe('foo/{a,{b,c}}');
  });
  it('rejects recursive exhaustion and oversized input',()=>{
    expect(()=>validateGlobPattern('{'.repeat(30)+'a'+'}'.repeat(30))).toThrow(/nesting/);
    expect(()=>validateGlobPattern('a'.repeat(2049))).toThrow(/2048/);
    expect(()=>validateGlobPattern('{abc')).toThrow(/unmatched/);
    expect(()=>validateGlobPattern('abc}')).toThrow(/unmatched/);
  });
});
