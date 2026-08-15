#!/usr/bin/env node

/**
 * watch-and-sync.cjs
 * Multi-Workspace Real-time File Watcher Daemon with Smart Singleton:
 * Listens for file changes across primary and federated workspaces, invoking
 * incremental wiki synchronization with intelligent debouncing.
 * 
 * Guarantees SINGLETON execution: automatically detects and terminates any duplicate
 * watcher instances so only exactly ONE watcher process is running at all times.
 * 
 * Usage:
 *   node watch-and-sync.cjs [--config <file>] [--wiki-dir <dir>] [--debounce <ms>] [--stop]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();
const lockFilePath = path.join(rootDir, '.wiki-watcher.pid');
const syncerScript = path.resolve(__dirname, 'sync-wiki-on-change.cjs');

const args = process.argv.slice(2);
let configFile = 'docs/wiki/wiki-config.json';
let wikiDir = 'docs/wiki';
let debounceMs = 600;
let isStopCommand = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    configFile = args[++i];
  } else if (args[i] === '--wiki-dir' || args[i] === '-w') {
    wikiDir = args[++i];
  } else if (args[i] === '--debounce' || args[i] === '-d') {
    debounceMs = parseInt(args[++i], 10) || 600;
  } else if (args[i] === '--stop') {
    isStopCommand = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Multi-Workspace Real-Time Wiki Auto-Sync Watcher Daemon
Usage:
  node watch-and-sync.cjs [options]

Options:
  --config, -c <file>      Path to wiki-config.json (default: docs/wiki/wiki-config.json)
  --wiki-dir, -w <dir>     Destination wiki directory (default: docs/wiki)
  --debounce, -d <ms>      Debounce delay in milliseconds (default: 600)
  --stop                   Stop any currently running watcher daemon and exit
  --help, -h               Show this help message
    `);
    process.exit(0);
  }
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

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function killProcess(pid) {
  try {
    if (isPidRunning(pid) && pid !== process.pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {
          try { process.kill(pid, 'SIGTERM'); } catch (__) {}
        }
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) {
          try { process.kill(pid, 'SIGKILL'); } catch (__) {}
        }
      }
      return true;
    }
  } catch (_) {}
  return false;
}

if (isStopCommand) {
  if (fs.existsSync(lockFilePath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
      const oldPid = lockData.pid;
      if (oldPid && isPidRunning(oldPid)) {
        console.log(`🛑 Stopping active multi-workspace wiki watcher (PID: ${oldPid})...`);
        killProcess(oldPid);
        console.log(`✅ Wiki watcher daemon (PID: ${oldPid}) stopped.`);
      } else {
        console.log(`ℹ️ No active wiki watcher daemon running (stale PID ${oldPid}).`);
      }
      fs.unlinkSync(lockFilePath);
    } catch (e) {
      try { fs.unlinkSync(lockFilePath); } catch (_) {}
    }
  } else {
    console.log(`ℹ️ No active wiki watcher lockfile found.`);
  }
  process.exit(0);
}

function enforceSingleton() {
  if (fs.existsSync(lockFilePath)) {
    try {
      const content = fs.readFileSync(lockFilePath, 'utf8').trim();
      const lockData = JSON.parse(content);
      const oldPid = lockData.pid;

      if (oldPid && oldPid !== process.pid && isPidRunning(oldPid)) {
        console.log(`\n🔍 [Singleton Lock] Ditemukan instance wiki-watcher yang sedang berjalan (PID: ${oldPid}).`);
        console.log(`🧹 Mematikan instance duplikat (PID: ${oldPid}) agar hanya ada 1 instance watcher aktif...`);
        const killed = killProcess(oldPid);
        if (killed) {
          console.log(`✅ Instance duplikat (PID: ${oldPid}) berhasil dimatikan.`);
        }
        const start = Date.now();
        while (Date.now() - start < 250) {}
      }
    } catch (_) {}
  }

  const currentLock = {
    pid: process.pid,
    startTime: new Date().toISOString(),
    wikiDir: wikiDir,
    cwd: rootDir,
    workspaces: workspaces.map(w => ({ name: w.name, path: w.baseDir }))
  };
  fs.writeFileSync(lockFilePath, JSON.stringify(currentLock, null, 2), 'utf8');
}

function cleanupLock() {
  try {
    if (fs.existsSync(lockFilePath)) {
      const content = fs.readFileSync(lockFilePath, 'utf8').trim();
      const data = JSON.parse(content);
      if (data.pid === process.pid) {
        fs.unlinkSync(lockFilePath);
      }
    }
  } catch (_) {}
}

process.on('exit', cleanupLock);
process.on('SIGINT', () => { cleanupLock(); process.exit(0); });
process.on('SIGTERM', () => { cleanupLock(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception in Multi-Workspace Wiki Watcher:', err);
  cleanupLock();
  process.exit(1);
});

enforceSingleton();

console.log(`\n👁️‍🗨️ Starting Multi-Workspace Wiki Auto-Sync Watcher Daemon...`);
console.log(`📁 Primary Workspace : ${rootDir}`);
console.log(`🌐 Total Workspaces  : ${workspaces.length} (${workspaces.map(w => w.name).join(', ')})`);
console.log(`📚 Target Wiki       : ${wikiDir}`);
console.log(`⏱️ Debounce Delay    : ${debounceMs}ms`);
console.log(`🔒 Singleton PID     : ${process.pid} (Single active instance guaranteed)\n`);

let changedFilesQueue = new Set();
let debounceTimer = null;
let isSyncRunning = false;
let pendingSyncAfterRun = false;

function triggerSync() {
  if (isSyncRunning) {
    pendingSyncAfterRun = true;
    return;
  }

  const filesList = Array.from(changedFilesQueue);
  changedFilesQueue.clear();

  if (filesList.length === 0) return;

  isSyncRunning = true;
  pendingSyncAfterRun = false;
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] ⚡ Detected ${filesList.length} changed files across workspaces. Triggering sync...`);
  
  try {
    const filesParam = filesList.slice(0, 20).join(',');
    execSync(`node "${syncerScript}" --config "${resolvedConfigPath}" --wiki-dir "${wikiDir}" --files "${filesParam}"`, {
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (err) {
    console.error(`[${timestamp}] ❌ Error running multi-workspace auto-sync:`, err.message);
  } finally {
    isSyncRunning = false;
    if (pendingSyncAfterRun || changedFilesQueue.size > 0) {
      setTimeout(triggerSync, 200);
    }
  }
}

const ignoredPatterns = [
  'node_modules', '.git', 'dist', 'build', '.turbo', '.next', '.vite',
  'coverage', '.hallmark', 'cache', 'data/logs', 'data/uploads',
  wikiDir.replace(/\\/g, '/'), '.log', '.wiki-watcher.pid', 'tmp', 'temp'
];

const allowedExtensions = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.json', '.sql', '.prisma', '.yml', '.yaml', '.md'
]);

function shouldIgnore(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  if (ignoredPatterns.some(pat => norm.includes(pat))) return true;
  const baseName = path.basename(filePath);
  if (baseName.startsWith('.') && !baseName.startsWith('.env')) return true;
  if (baseName.endsWith('~') || baseName.endsWith('.swp') || baseName.endsWith('.tmp')) return true;
  const ext = path.extname(filePath).toLowerCase();
  if (baseName.startsWith('.env')) return false;
  if (!ext || !allowedExtensions.has(ext)) return true;
  return false;
}

function setupWorkspaceWatcher(ws) {
  try {
    fs.watch(ws.baseDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(ws.baseDir, filename);
      if (shouldIgnore(fullPath)) return;

      const taggedFile = ws.name === 'smart-seller' ? path.relative(rootDir, fullPath) : `[${ws.name}] ${filename}`;
      changedFilesQueue.add(taggedFile);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(triggerSync, debounceMs);
    });
    console.log(`🟢 Watching Workspace: ${ws.displayName}`);
  } catch (err) {
    console.warn(`⚠️ Recursive watcher failed on ${ws.name} (${err.message}). Watching specific subfolders...`);
    const subdirs = ['apps', 'packages', 'src', 'routes', 'backend', 'frontend', 'prisma', 'drizzle'];
    for (const d of subdirs) {
      const full = path.join(ws.baseDir, d);
      if (fs.existsSync(full)) {
        try {
          fs.watch(full, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const fullPath = path.join(full, filename);
            if (shouldIgnore(fullPath)) return;
            const taggedFile = ws.name === 'smart-seller' ? path.relative(rootDir, fullPath) : `[${ws.name}] ${d}/${filename}`;
            changedFilesQueue.add(taggedFile);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(triggerSync, debounceMs);
          });
          console.log(`  - 🟢 Watching: ${ws.name}/${d}`);
        } catch (_) {}
      }
    }
  }
}

for (const ws of workspaces) {
  setupWorkspaceWatcher(ws);
}

// Initial sync on start
console.log(`\n🚀 Performing initial multi-workspace sync check on startup...`);
try {
  execSync(`node "${syncerScript}" --config "${resolvedConfigPath}" --wiki-dir "${wikiDir}" --git-diff`, {
    cwd: rootDir,
    stdio: 'inherit'
  });
} catch (_) {}

console.log(`\n✨ Multi-Workspace Wiki Watcher Daemon is active (PID: ${process.pid}). Auto-syncing on every file save.`);
