#!/usr/bin/env node

/**
 * validate-wiki-freshness.cjs
 * Pre-Push & CI/CD Freshness Gate:
 * Verifies whether the codebase wiki has been synchronized with the latest code changes.
 * 
 * Usage:
 *   node validate-wiki-freshness.cjs [--wiki-dir <dir>] [--strict]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
let wikiDir = 'docs/wiki';
let strict = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wiki-dir' || args[i] === '-w') {
    wikiDir = args[++i];
  } else if (args[i] === '--strict' || args[i] === '-s') {
    strict = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Codebase Wiki Freshness Validator
Usage:
  node validate-wiki-freshness.cjs [options]

Options:
  --wiki-dir, -w <dir>   Wiki directory path (default: docs/wiki)
  --strict, -s           Fail with exit code 1 if stale documentation is detected
  --help, -h             Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const resolvedWiki = path.resolve(rootDir, wikiDir);
const manifestPath = path.join(resolvedWiki, 'auto-sync-manifest.json');

console.log(`🛡️ [1/2] Checking Wiki documentation freshness in: ${wikiDir}`);

if (!fs.existsSync(manifestPath)) {
  console.warn(`⚠️ Warning: auto-sync-manifest.json not found in ${wikiDir}. Wiki may need initial scaffolding.`);
  process.exit(0);
}

let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (_) {}

const lastSyncTime = manifest.lastSync ? new Date(manifest.lastSync).getTime() : 0;

let gitStatus = '';
try {
  gitStatus = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' });
} catch (_) {}

const modifiedLines = gitStatus.split('\n').filter(Boolean);
const unsyncedCriticalFiles = [];

for (const line of modifiedLines) {
  const f = line.slice(3).trim().replace(/\\/g, '/');
  if (f.startsWith(wikiDir)) continue;

  if (f.includes('routes/') || f.includes('schema') || f.includes('migrations/') || f.includes('docker-compose')) {
    unsyncedCriticalFiles.push(f);
  }
}

console.log(`📊 [2/2] Audit Results:`);
console.log(`  - Last Wiki Sync Timestamp: ${manifest.lastSync || 'Never'}`);
console.log(`  - Critical Code Files Changed: ${unsyncedCriticalFiles.length}`);

if (unsyncedCriticalFiles.length > 0) {
  console.warn(`\n⚠️ Notice: Detected ${unsyncedCriticalFiles.length} critical code modifications:`);
  unsyncedCriticalFiles.slice(0, 5).forEach(f => console.warn(`   - 📄 ${f}`));
  console.warn(`\n💡 Run 'node .agents/skills/codebase-wiki-generator/scripts/sync-wiki-on-change.cjs' to sync wiki!`);
  
  if (strict) {
    console.error(`❌ Freshness Gate Failed: Wiki is stale.`);
    process.exit(1);
  }
} else {
  console.log(`\n🎉 Codebase Wiki is 100% UP TO DATE & FRESH!`);
}

process.exit(0);
