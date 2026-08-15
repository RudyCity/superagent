#!/usr/bin/env node

/**
 * sync-wiki-on-change.cjs
 * Multi-Workspace Incremental Wiki Synchronizer:
 * Detects git changes across primary and federated workspaces, calculates impact,
 * and automatically updates corresponding Wiki sections (API catalogs, ERD schemas,
 * Package topologies, Index timestamps, and Vector RAG chunks).
 * 
 * Usage:
 *   node sync-wiki-on-change.cjs [--config <file>] [--wiki-dir <dir>] [--files <file1,file2,...>] [--git-diff]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
let configFile = 'docs/wiki/wiki-config.json';
let wikiDir = 'docs/wiki';
let explicitFiles = [];
let useGitDiff = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    configFile = args[++i];
  } else if (args[i] === '--wiki-dir' || args[i] === '-w') {
    wikiDir = args[++i];
  } else if (args[i] === '--files' || args[i] === '-f') {
    explicitFiles = args[++i].split(',').map(s => s.trim());
    useGitDiff = false;
  } else if (args[i] === '--git-diff' || args[i] === '-g') {
    useGitDiff = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Multi-Workspace Incremental Wiki Synchronizer
Usage:
  node sync-wiki-on-change.cjs [options]

Options:
  --config, -c <file>       Path to wiki-config.json (default: docs/wiki/wiki-config.json)
  --wiki-dir, -w <dir>      Directory containing wiki documentation (default: docs/wiki)
  --files, -f <file1,file2> Explicit list of changed files to process
  --git-diff, -g            Query git status across all workspaces (default)
  --help, -h                Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const resolvedWiki = path.resolve(rootDir, wikiDir);

if (!fs.existsSync(resolvedWiki)) {
  console.log(`⚠️ Wiki directory not found at: ${resolvedWiki}`);
  console.log(`💡 Run 'node .agents/skills/codebase-wiki-generator/scripts/generate-wiki-scaffold.cjs' first.`);
  process.exit(1);
}

// Load config
let config = null;
const resolvedConfigPath = path.resolve(rootDir, configFile);
if (fs.existsSync(resolvedConfigPath)) {
  try {
    config = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  } catch (err) {
    console.warn(`⚠️ Could not parse config ${configFile}: ${err.message}`);
  }
}

const workspaces = [];
if (config && config.primaryWorkspace) {
  workspaces.push({
    name: config.primaryWorkspace.name || 'smart-seller',
    displayName: config.primaryWorkspace.displayName || 'Primary Core (smart-seller)',
    baseDir: path.resolve(rootDir, config.primaryWorkspace.path || '.')
  });

  if (Array.isArray(config.federatedWorkspaces)) {
    for (const fw of config.federatedWorkspaces) {
      if (fw.path && fs.existsSync(path.resolve(rootDir, fw.path))) {
        workspaces.push({
          name: fw.name || path.basename(fw.path),
          displayName: fw.displayName || `Federated: ${fw.name}`,
          baseDir: path.resolve(rootDir, fw.path)
        });
      }
    }
  }
} else {
  workspaces.push({
    name: 'smart-seller',
    displayName: 'Primary Core (smart-seller)',
    baseDir: rootDir
  });
}

// 1. Gather changed files across workspaces
const changedFiles = [];
const changedByWorkspace = new Map();

for (const ws of workspaces) {
  let wsChanged = [];
  if (explicitFiles.length > 0) {
    wsChanged = explicitFiles.filter(f => f.startsWith(ws.name) || ws.name === 'smart-seller');
  } else if (useGitDiff) {
    try {
      const statusOutput = execSync('git status --porcelain', { cwd: ws.baseDir, encoding: 'utf8' });
      wsChanged = statusOutput
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => line.slice(3).trim())
        .map(f => f.replace(/^"|"$/g, ''))
        .map(f => ws.name === 'smart-seller' ? f : `[${ws.name}] ${f}`);
    } catch (err) {
      // non-fatal git query error
    }
  }
  changedByWorkspace.set(ws.name, wsChanged);
  changedFiles.push(...wsChanged);
}

console.log(`🔄 [1/4] Analyzing ${changedFiles.length} modified files across ${workspaces.length} workspace(s)...`);
if (changedFiles.length > 0) {
  changedFiles.slice(0, 10).forEach(f => console.log(`   - 📄 ${f}`));
  if (changedFiles.length > 10) console.log(`   - ... and ${changedFiles.length - 10} more files`);
}

// 2. Impact Analysis Matrix
const impact = {
  architecture: false, // 01-architecture-overview.md
  domainData: false,   // 02-domain-models-and-data.md
  apiContracts: false, // 03-api-and-contracts.md
  features: false,     // 04-features-and-workflows.md
  devops: false,       // 05-infrastructure-and-devops.md
  onboarding: false,   // 06-developer-onboarding.md
  index: true          // 00-index.md (always update timestamp)
};

const changedDetails = [];

for (const file of changedFiles) {
  const norm = file.replace(/\\/g, '/');

  // Ignore wiki self-changes
  if (norm.startsWith(wikiDir.replace(/\\/g, '/'))) continue;

  if (norm.includes('package.json') || norm.includes('pnpm-workspace.yaml') || norm.includes('turbo.json')) {
    impact.architecture = true;
    changedDetails.push({ file: norm, target: '01-architecture-overview.md', reason: 'Dependencies or Workspace Structure modified' });
  }

  if (norm.includes('routes/') || norm.includes('api/') || norm.includes('controllers/') || norm.endsWith('server.ts') || norm.endsWith('app.ts')) {
    impact.apiContracts = true;
    changedDetails.push({ file: norm, target: '03-api-and-contracts.md', reason: 'API Endpoint Route Handler modified' });
  }

  if (norm.includes('schema') || norm.includes('migrations/') || norm.includes('entities/') || norm.includes('models/') || norm.includes('prisma') || norm.includes('drizzle')) {
    impact.domainData = true;
    changedDetails.push({ file: norm, target: '02-domain-models-and-data.md', reason: 'Database Schema or Migration modified' });
  }

  if (norm.includes('docker') || norm.includes('.github/') || norm.includes('.env') || norm.includes('nginx') || norm.includes('k8s')) {
    impact.devops = true;
    changedDetails.push({ file: norm, target: '05-infrastructure-and-devops.md', reason: 'Infrastructure / DevOps Config modified' });
  }

  if (norm.includes('services/') || norm.includes('features/') || norm.includes('assistant/') || norm.includes('agent/') || norm.includes('checkout')) {
    impact.features = true;
    changedDetails.push({ file: norm, target: '04-features-and-workflows.md', reason: 'Business Domain Feature Logic modified' });
  }
}

console.log(`\n🎯 [2/4] Impact Radius Summary:`);
console.log(`   - 01-architecture-overview.md : ${impact.architecture ? '🔴 ACTION REQUIRED' : '🟢 Up to date'}`);
console.log(`   - 02-domain-models-and-data.md: ${impact.domainData ? '🔴 ACTION REQUIRED' : '🟢 Up to date'}`);
console.log(`   - 03-api-and-contracts.md     : ${impact.apiContracts ? '🔴 ACTION REQUIRED (Auto-Extracting)' : '🟢 Up to date'}`);
console.log(`   - 04-features-and-workflows.md: ${impact.features ? '🔴 ACTION REQUIRED' : '🟢 Up to date'}`);
console.log(`   - 05-infrastructure-and-devops.md: ${impact.devops ? '🔴 ACTION REQUIRED' : '🟢 Up to date'}`);
console.log(`   - 00-index.md                 : 🔵 Updating Timestamp & Sync Log`);

// 3. Perform automated updates
console.log(`\n⚡ [3/4] Executing Automatic Multi-Workspace Synchronization...`);

const nowIso = new Date().toISOString();
const dateStr = nowIso.split('T')[0];
const timeStr = nowIso.split('T')[1].slice(0, 8);

// A. Auto-update API Contracts across workspaces
if (impact.apiContracts) {
  const extractorScript = path.resolve(__dirname, 'extract-api-catalog.cjs');
  try {
    execSync(`node "${extractorScript}" --config "${resolvedConfigPath}" --update-wiki --wiki-file "${path.join(wikiDir, '03-api-and-contracts.md').replace(/\\/g, '/')}"`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (e) {
    console.log(`⚠️ Auto-extraction warning: ${e.message}`);
  }
}

// B. Auto-update Database ERD & Schema across workspaces
if (impact.domainData) {
  const erdScript = path.resolve(__dirname, 'extract-db-erd.cjs');
  try {
    execSync(`node "${erdScript}" --config "${resolvedConfigPath}" --update-wiki --wiki-file "${path.join(wikiDir, '02-domain-models-and-data.md').replace(/\\/g, '/')}"`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (e) {
    console.log(`⚠️ Auto-ERD extraction warning: ${e.message}`);
  }
}

// C. Auto-update 00-index.md timestamp and changelog
const indexPath = path.join(resolvedWiki, '00-index.md');
if (fs.existsSync(indexPath)) {
  let indexContent = fs.readFileSync(indexPath, 'utf8');

  // Update Last Synced Header
  if (indexContent.includes('Last Synced:')) {
    indexContent = indexContent.replace(/\*Last Synced:.*?\*/, `*Last Synced: ${dateStr} ${timeStr} UTC*`);
  }

  // Update Recent Sync Log
  const syncLogMarkerStart = '<!-- RECENT_SYNC_LOG_START -->';
  const syncLogMarkerEnd = '<!-- RECENT_SYNC_LOG_END -->';

  let logSnippet = `${syncLogMarkerStart}\n`;
  logSnippet += `### 🕒 Last Sync Event: ${dateStr} ${timeStr} UTC (Multi-Workspace: ${workspaces.map(w => w.name).join(', ')})\n`;
  logSnippet += `| Modified Source File | Impacted Wiki Section | Change Trigger |\n`;
  logSnippet += `|:---|:---|:---|\n`;

  if (changedDetails.length > 0) {
    for (const c of changedDetails.slice(0, 15)) {
      logSnippet += `| \`${c.file}\` | [${c.target}](./${c.target}) | ${c.reason} |\n`;
    }
  } else {
    logSnippet += `| *(All Workspaces Clean / No uncommitted changes)* | [All Wiki Docs](./00-index.md) | Routine Verification Sync |\n`;
  }
  logSnippet += `${syncLogMarkerEnd}`;

  if (indexContent.includes(syncLogMarkerStart) && indexContent.includes(syncLogMarkerEnd)) {
    indexContent = indexContent.replace(
      /<!-- RECENT_SYNC_LOG_START -->[\s\S]*?<!-- RECENT_SYNC_LOG_END -->/,
      logSnippet
    );
  } else {
    indexContent += `\n\n## 🔄 Real-time Codebase Sync Status\n\n${logSnippet}\n`;
  }

  fs.writeFileSync(indexPath, indexContent, 'utf8');
  console.log(`   ✅ Synced 00-index.md (Timestamp: ${dateStr} ${timeStr} UTC)`);
}

// D. Auto-sync semantic chunks to rMemory Vector Store for AI Copilot
const rmemoryScript = path.resolve(__dirname, 'sync-wiki-to-rmemory.cjs');
try {
  execSync(`node "${rmemoryScript}" --wiki-dir "${wikiDir}"`, {
    cwd: rootDir,
    stdio: 'inherit'
  });
} catch (e) {
  // non-fatal: memory sync warning
}

// E. Ensure Docsify web viewer files exist
const sidebarPath = path.join(resolvedWiki, '_sidebar.md');
if (!fs.existsSync(sidebarPath)) {
  const sidebarContent = `* **Dokumentasi Utama**
  * [📖 Master Index & Ringkasan](00-index.md)
  * [🏛️ C4 Arsitektur Sistem](01-architecture-overview.md)
  * [🗄️ Domain Models & ERD](02-domain-models-and-data.md)
  * [🔌 API Catalog & Contracts](03-api-and-contracts.md)
  * [🔄 Alur Bisnis & Workflows](04-features-and-workflows.md)
  * [🚢 Infrastruktur & DevOps](05-infrastructure-and-devops.md)
  * [🚀 Developer Onboarding](06-developer-onboarding.md)
  * [📜 ADR & Keputusan Arsitektur](07-adrs-and-decisions.md)
`;
  fs.writeFileSync(sidebarPath, sidebarContent, 'utf8');
}

const viewerIndexPath = path.join(resolvedWiki, 'index.html');
if (!fs.existsSync(viewerIndexPath)) {
  const indexHtmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Technical Wiki</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify@4/lib/themes/vue.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.css">
  <style>
    :root { --theme-color: #f59e0b; }
    .sidebar { border-right: 2px solid #000 !important; background: #fafafa; }
    .markdown-section pre>code { border: 2px solid #000; border-radius: 8px; box-shadow: 2px 2px 0px 0px #000; }
    .markdown-section table { border: 2px solid #000; box-shadow: 3px 3px 0px 0px #000; }
    .markdown-section th { background: #fef08a; color: #000; font-weight: 900; }
  </style>
</head>
<body>
  <div id="app">Memuat Technical Wiki...</div>
  <script>
    window.$docsify = {
      name: '⚡ Technical Wiki',
      loadSidebar: true,
      homepage: '00-index.md',
      auto2top: true,
      search: { placeholder: 'Cari dokumentasi...', noData: 'Tidak ditemukan hasil!', depth: 3 },
      mermaidConfig: { querySelector: ".mermaid" }
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/search.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify-copy-code/dist/docsify-copy-code.min.js"></script>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
    window.mermaid = mermaid;
  </script>
  <script src="https://unpkg.com/docsify-mermaid@2.0.1/dist/docsify-mermaid.js"></script>
</body>
</html>`;
  fs.writeFileSync(viewerIndexPath, indexHtmlContent, 'utf8');
}

// 4. Update manifest file
const manifestPath = path.join(resolvedWiki, 'auto-sync-manifest.json');
let manifest = {};
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {}
}

manifest.lastSync = nowIso;
manifest.workspaces = workspaces.map(w => ({ name: w.name, path: w.baseDir }));
manifest.lastModifiedFiles = changedFiles.slice(0, 50);
manifest.impactSummary = impact;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

console.log(`\n🎉 [4/4] Multi-Workspace Wiki auto-sync complete! Manifest updated.`);
console.log(`🌐 Live Web Viewer URL: http://localhost:3333 (Run 'bun run wiki:serve' to view)`);
