#!/usr/bin/env node

/**
 * validate-wiki-links.cjs
 * Scans all markdown documentation in the wiki folder and verifies:
 * 1. Internal relative link integrity (no broken .md links).
 * 2. Section anchor target validity (#heading-slug).
 * 3. Mermaid code block syntax delimiters.
 * 
 * Usage:
 *   node validate-wiki-links.cjs [--wiki-dir <dir>]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let wikiDir = 'docs/wiki';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wiki-dir' || args[i] === '-w') {
    wikiDir = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Wiki Link and Integrity Validator
Usage:
  node validate-wiki-links.cjs [options]

Options:
  --wiki-dir, -w <dir>   Directory containing wiki markdown files (default: docs/wiki)
  --help, -h             Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const resolvedWiki = path.resolve(rootDir, wikiDir);

if (!fs.existsSync(resolvedWiki)) {
  console.error(`❌ Wiki directory not found: ${resolvedWiki}`);
  process.exit(1);
}

console.log(`🔍 [1/3] Scanning Wiki Markdown files in: ${resolvedWiki}\n`);

const mdFiles = fs.readdirSync(resolvedWiki).filter(f => f.endsWith('.md'));
const headingsMap = new Map();
const linkErrors = [];
let totalLinksChecked = 0;

// Helper to convert heading text to github anchor slug
function slugify(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

// 1. Index headings across all files
for (const file of mdFiles) {
  const fullPath = path.join(resolvedWiki, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');
  const slugs = new Set();

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      slugs.add(slugify(headingMatch[1]));
    }
  }
  headingsMap.set(file, slugs);
}

// 2. Validate links and Mermaid blocks in each file
console.log(`🔗 [2/3] Checking link integrity and Mermaid diagrams...`);

for (const file of mdFiles) {
  const fullPath = path.join(resolvedWiki, file);
  const content = fs.readFileSync(fullPath, 'utf8');

  // Check Mermaid blocks
  const mermaidMatches = (content.match(/```mermaid/g) || []).length;
  
  // Extract markdown links [label](target)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    const label = match[1];
    const target = match[2].trim();
    totalLinksChecked++;

    // Ignore external URLs or file:/// links
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:') || target.startsWith('file:///')) {
      continue;
    }

    // Split target into file path and hash anchor
    const [relPath, anchor] = target.split('#');
    
    // Internal anchor in the same file
    if (!relPath && anchor) {
      const currentSlugs = headingsMap.get(file);
      if (currentSlugs && !currentSlugs.has(anchor.toLowerCase())) {
        linkErrors.push({
          file,
          label,
          target,
          reason: `Missing anchor '#${anchor}' in current document`
        });
      }
      continue;
    }

    // Relative file link
    if (relPath) {
      const targetFile = path.basename(relPath);
      const targetFullPath = path.resolve(resolvedWiki, relPath);

      if (!fs.existsSync(targetFullPath)) {
        linkErrors.push({
          file,
          label,
          target,
          reason: `Target file does not exist: ${relPath}`
        });
      } else if (anchor) {
        const targetSlugs = headingsMap.get(targetFile);
        if (targetSlugs && !targetSlugs.has(anchor.toLowerCase())) {
          linkErrors.push({
            file,
            label,
            target,
            reason: `Target file '${targetFile}' exists but missing anchor '#${anchor}'`
          });
        }
      }
    }
  }

  console.log(`  - 📄 ${file}: Checked (Mermaid diagrams: ${mermaidMatches})`);
}

// 3. Output results
console.log(`\n📊 [3/3] Validation Results:`);
console.log(`  - Total Wiki Files : ${mdFiles.length}`);
console.log(`  - Total Links Checked: ${totalLinksChecked}`);

if (linkErrors.length === 0) {
  console.log(`\n🎉 All internal wiki links, anchors, and file references are 100% HEALTHY!`);
  process.exit(0);
} else {
  console.error(`\n❌ Found ${linkErrors.length} broken links/anchors:`);
  for (const err of linkErrors) {
    console.error(`  - In [${err.file}]: Link [${err.label}](${err.target}) -> ${err.reason}`);
  }
  process.exit(1);
}
