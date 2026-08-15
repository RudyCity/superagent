#!/usr/bin/env node

/**
 * sync-wiki-to-rmemory.cjs
 * Vector RAG Knowledge Memory Syncer:
 * Parses all generated wiki markdown documents, splits them into semantic chunks,
 * and synchronizes them with the RMemory vector knowledge base for AI Customer Agents & Store Copilots.
 * 
 * Usage:
 *   node sync-wiki-to-rmemory.cjs [--wiki-dir <dir>] [--output-json <file>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
let wikiDir = 'docs/wiki';
let outputJson = 'apps/api/data/wiki-rmemory-chunks.json';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wiki-dir' || args[i] === '-w') {
    wikiDir = args[++i];
  } else if (args[i] === '--output-json' || args[i] === '-o') {
    outputJson = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Vector RAG Memory Syncer for Codebase Wiki
Usage:
  node sync-wiki-to-rmemory.cjs [options]

Options:
  --wiki-dir, -w <dir>       Directory containing wiki markdown files (default: docs/wiki)
  --output-json, -o <file>   Destination JSON file for memory chunks (default: apps/api/data/wiki-rmemory-chunks.json)
  --help, -h                 Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const resolvedWiki = path.resolve(rootDir, wikiDir);

if (!fs.existsSync(resolvedWiki)) {
  console.error(`❌ Wiki directory not found at: ${resolvedWiki}`);
  process.exit(1);
}

console.log(`🧠 [1/3] Chunking Wiki documentation for Vector RAG search...`);

const mdFiles = fs.readdirSync(resolvedWiki).filter(f => f.endsWith('.md'));
const memoryChunks = [];

for (const file of mdFiles) {
  const fullPath = path.join(resolvedWiki, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  let currentSectionTitle = path.basename(file, '.md');
  let currentChunkLines = [];

  for (const line of lines) {
    if (line.match(/^#{1,3}\s+(.+)$/)) {
      if (currentChunkLines.length > 0) {
        const text = currentChunkLines.join('\n').trim();
        if (text.length > 50) {
          const chunkId = crypto.createHash('sha256').update(`${file}:${currentSectionTitle}:${text.slice(0, 100)}`).digest('hex').slice(0, 16);
          memoryChunks.push({
            id: `wiki-${chunkId}`,
            document: file,
            section: currentSectionTitle,
            content: text,
            updatedAt: new Date().toISOString()
          });
        }
        currentChunkLines = [];
      }
      currentSectionTitle = line.replace(/^#{1,3}\s+/, '').trim();
    } else {
      currentChunkLines.push(line);
    }
  }

  // Last chunk
  if (currentChunkLines.length > 0) {
    const text = currentChunkLines.join('\n').trim();
    if (text.length > 50) {
      const chunkId = crypto.createHash('sha256').update(`${file}:${currentSectionTitle}:${text.slice(0, 100)}`).digest('hex').slice(0, 16);
      memoryChunks.push({
        id: `wiki-${chunkId}`,
        document: file,
        section: currentSectionTitle,
        content: text,
        updatedAt: new Date().toISOString()
      });
    }
  }
}

console.log(`✅ [2/3] Generated ${memoryChunks.length} semantic RAG chunks from ${mdFiles.length} wiki files.`);

const destPath = path.resolve(rootDir, outputJson);
const destDir = path.dirname(destPath);
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

fs.writeFileSync(destPath, JSON.stringify(memoryChunks, null, 2), 'utf8');
console.log(`💾 [3/3] Exported memory chunks to: ${outputJson}`);
console.log(`🎉 AI Customer Agent & Store Copilot can now perform instant semantic search across all wiki docs!`);
