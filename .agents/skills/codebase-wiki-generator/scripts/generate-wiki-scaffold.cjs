#!/usr/bin/env node

/**
 * generate-wiki-scaffold.cjs
 * Automatically inspects the current codebase, detects architecture, framework,
 * databases, monorepo packages, and generates a structured codebase wiki with initial boilerplate.
 * 
 * Usage:
 *   node generate-wiki-scaffold.cjs [--target <dir>] [--force]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse CLI Arguments
const args = process.argv.slice(2);
let targetDir = 'docs/wiki';
let force = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target' || args[i] === '-t') {
    targetDir = args[++i];
  } else if (args[i] === '--force' || args[i] === '-f') {
    force = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Codebase Wiki Scaffold Generator
Usage:
  node generate-wiki-scaffold.cjs [options]

Options:
  --target, -t <dir>   Destination directory for wiki (default: docs/wiki)
  --force, -f          Overwrite existing wiki files
  --help, -h           Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const resolvedTarget = path.resolve(rootDir, targetDir);

console.log(`🔍 [1/4] Inspecting codebase at: ${rootDir}`);

// 1. Inspect package.json and workspace
let rootPkg = {};
try {
  rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
} catch (e) {
  // Not a node root or no package.json
}

const projectName = rootPkg.name || path.basename(rootDir);
const projectDesc = rootPkg.description || 'Enterprise Cloud & Web System';
const projectVersion = rootPkg.version || '1.0.0';

// Detect monorepo packages
const detectedApps = [];
const detectedPackages = [];

function scanSubdirs(dirName, targetList) {
  const fullPath = path.join(rootDir, dirName);
  if (fs.existsSync(fullPath)) {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const pkgJson = path.join(fullPath, ent.name, 'package.json');
        let name = ent.name;
        let desc = '';
        if (fs.existsSync(pkgJson)) {
          try {
            const p = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            name = p.name || name;
            desc = p.description || '';
          } catch (_) {}
        }
        targetList.push({ name, dir: path.join(dirName, ent.name).replace(/\\/g, '/'), desc });
      }
    }
  }
}

scanSubdirs('apps', detectedApps);
scanSubdirs('packages', detectedPackages);
scanSubdirs('modules', detectedPackages);

// Detect Databases
const detectedDbs = [];
if (fs.existsSync(path.join(rootDir, 'docker-compose.yml')) || fs.existsSync(path.join(rootDir, 'docker-compose.yaml'))) {
  const dc = fs.readFileSync(path.join(rootDir, fs.existsSync(path.join(rootDir, 'docker-compose.yml')) ? 'docker-compose.yml' : 'docker-compose.yaml'), 'utf8');
  if (dc.includes('postgres')) detectedDbs.push('PostgreSQL');
  if (dc.includes('mysql') || dc.includes('mariadb')) detectedDbs.push('MySQL/MariaDB');
  if (dc.includes('redis')) detectedDbs.push('Redis');
  if (dc.includes('mongo')) detectedDbs.push('MongoDB');
}
if (detectedDbs.length === 0) {
  detectedDbs.push('PostgreSQL / Relational Database');
}

console.log(`📦 [2/4] Discovered: Project=${projectName}, Apps=${detectedApps.length}, Packages=${detectedPackages.length}`);

// 2. Prepare templates
const templatesDir = path.resolve(__dirname, '../templates');
const nowIso = new Date().toISOString().split('T')[0];

const wikiFiles = [
  {
    fileName: '00-index.md',
    template: '00-index.template.md',
    title: 'Master Architecture & Table of Contents'
  },
  {
    fileName: '01-architecture-overview.md',
    template: '01-architecture-overview.template.md',
    title: 'System Architecture & C4 Topology'
  },
  {
    fileName: '02-domain-models-and-data.md',
    template: '02-domain-models-and-data.template.md',
    title: 'Domain Entities, Schemas & ERD'
  },
  {
    fileName: '03-api-and-contracts.md',
    template: '03-api-and-contracts.template.md',
    title: 'API Catalog & Interface Contracts'
  },
  {
    fileName: '04-features-and-workflows.md',
    template: '04-features-and-workflows.template.md',
    title: 'Core Business Features & Workflows'
  },
  {
    fileName: '05-infrastructure-and-devops.md',
    template: '05-infrastructure-and-devops.template.md',
    title: 'DevOps, CI/CD & Infrastructure'
  },
  {
    fileName: '06-developer-onboarding.md',
    template: '06-developer-onboarding.template.md',
    title: 'Developer Onboarding & Runbooks'
  },
  {
    fileName: '07-adrs-and-decisions.md',
    template: '07-adrs-and-decisions.template.md',
    title: 'Architecture Decision Records (ADRs)'
  }
];

// Helper to replace placeholders
function renderTemplate(content) {
  const appsTable = detectedApps.length > 0 
    ? detectedApps.map(a => `| \`${a.name}\` | \`${a.dir}\` | ${a.desc || 'Application service'} |`).join('\n')
    : '| `app` | `src/` | Main application service |';

  const pkgsTable = detectedPackages.length > 0
    ? detectedPackages.map(p => `| \`${p.name}\` | \`${p.dir}\` | ${p.desc || 'Shared module/package'} |`).join('\n')
    : '| `core` | `packages/core` | Core shared business logic |';

  return content
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, projectDesc)
    .replace(/\{\{PROJECT_VERSION\}\}/g, projectVersion)
    .replace(/\{\{CURRENT_DATE\}\}/g, nowIso)
    .replace(/\{\{APPS_TABLE\}\}/g, appsTable)
    .replace(/\{\{PACKAGES_TABLE\}\}/g, pkgsTable)
    .replace(/\{\{DATABASE_ENGINES\}\}/g, detectedDbs.join(', '));
}

// 3. Ensure target directory exists
if (!fs.existsSync(resolvedTarget)) {
  fs.mkdirSync(resolvedTarget, { recursive: true });
}

console.log(`📝 [3/4] Writing Wiki documents to: ${resolvedTarget}`);

const manifest = {
  projectName,
  generatedAt: new Date().toISOString(),
  targetDir,
  trackedFiles: {},
  wikiPages: {}
};

for (const wf of wikiFiles) {
  const destPath = path.join(resolvedTarget, wf.fileName);
  const templatePath = path.join(templatesDir, wf.template);

  if (fs.existsSync(destPath) && !force) {
    console.log(`  - ⏩ ${wf.fileName} (already exists, skipping. Use --force to overwrite)`);
  } else {
    let content = '';
    if (fs.existsSync(templatePath)) {
      content = renderTemplate(fs.readFileSync(templatePath, 'utf8'));
    } else {
      content = `# ${wf.title}\n\n*Last updated: ${nowIso}*\n\n> Comprehensive documentation for ${projectName}.\n`;
    }
    fs.writeFileSync(destPath, content, 'utf8');
    console.log(`  - ✨ Created ${wf.fileName}`);
  }

  // Calculate file hash for auto-sync manifest
  if (fs.existsSync(destPath)) {
    const fileBuf = fs.readFileSync(destPath);
    manifest.wikiPages[wf.fileName] = {
      hash: crypto.createHash('sha256').update(fileBuf).digest('hex'),
      updatedAt: new Date().toISOString()
    };
  }
}

// 4. Write Docsify web viewer (index.html) and sidebar (_sidebar.md)
const sidebarPath = path.join(resolvedTarget, '_sidebar.md');
if (!fs.existsSync(sidebarPath) || force) {
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
  console.log(`  - 📑 Created _sidebar.md`);
}

const indexPath = path.join(resolvedTarget, 'index.html');
if (!fs.existsSync(indexPath) || force) {
  const indexHtmlContent = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>${projectName} Technical Wiki</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
  <meta name="description" content="${projectDesc}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify@4/lib/themes/vue.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.css">
  <style>
    :root {
      --theme-color: #f59e0b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
    }
    .sidebar {
      border-right: 2px solid #000 !important;
      background: #fafafa;
    }
    .sidebar-nav strong {
      font-weight: 900;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0.05em;
      color: #000;
    }
    .markdown-section pre>code {
      border: 2px solid #000;
      border-radius: 8px;
      background: #f8fafc;
      box-shadow: 2px 2px 0px 0px #000;
    }
    .markdown-section table {
      border: 2px solid #000;
      border-collapse: collapse;
      box-shadow: 3px 3px 0px 0px #000;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .markdown-section th {
      background: #fef08a;
      color: #000;
      font-weight: 900;
      border: 1px solid #000;
    }
    .markdown-section td {
      border: 1px solid #cbd5e1;
    }
  </style>
</head>
<body>
  <div id="app">Memuat Technical Wiki...</div>
  <script>
    window.$docsify = {
      name: '⚡ ${projectName} Wiki',
      repo: '',
      loadSidebar: true,
      homepage: '00-index.md',
      auto2top: true,
      search: {
        placeholder: 'Cari dokumentasi...',
        noData: 'Tidak ditemukan hasil!',
        depth: 3
      },
      mermaidConfig: {
        querySelector: ".mermaid"
      }
    }
  </script>
  <!-- Docsify v4 -->
  <script src="https://cdn.jsdelivr.net/npm/docsify@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/search.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify-copy-code/dist/docsify-copy-code.min.js"></script>
  <!-- Mermaid -->
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
    window.mermaid = mermaid;
  </script>
  <script src="https://unpkg.com/docsify-mermaid@2.0.1/dist/docsify-mermaid.js"></script>
</body>
</html>
`;
  fs.writeFileSync(indexPath, indexHtmlContent, 'utf8');
  console.log(`  - 🌐 Created index.html (Docsify Live Web Viewer)`);
}

// 5. Inject npm scripts to root package.json if available
const rootPkgPath = path.join(rootDir, 'package.json');
if (fs.existsSync(rootPkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    pkg.scripts = pkg.scripts || {};
    let modified = false;

    if (!pkg.scripts['wiki:serve']) {
      pkg.scripts['wiki:serve'] = `bun --bun x serve ${targetDir} -p 3333`;
      modified = true;
    }
    if (!pkg.scripts['wiki:sync']) {
      pkg.scripts['wiki:sync'] = 'node .agents/skills/codebase-wiki-generator/scripts/sync-wiki-on-change.cjs';
      modified = true;
    }
    if (!pkg.scripts['wiki:watch']) {
      pkg.scripts['wiki:watch'] = 'node .agents/skills/codebase-wiki-generator/scripts/watch-and-sync.cjs';
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      console.log(`  - ⚙️ Injected wiki scripts into package.json (wiki:serve, wiki:sync, wiki:watch)`);
    }
  } catch (e) {
    // ignore
  }
}

// 6. Write manifest
const manifestPath = path.join(resolvedTarget, 'auto-sync-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`  - 📄 Initialized auto-sync manifest: auto-sync-manifest.json`);

console.log(`\n🎉 [4/4] Wiki scaffold successfully generated at: ${targetDir}`);
console.log(`🌐 Live Web Viewer URL: http://localhost:3333 (Run 'bun run wiki:serve' to start)`);
console.log(`💡 Next steps:`);
console.log(`   1. Run 'node .agents/skills/codebase-wiki-generator/scripts/extract-api-catalog.cjs' to populate API routes.`);
console.log(`   2. Run 'node .agents/skills/codebase-wiki-generator/scripts/watch-and-sync.cjs' to enable real-time auto-sync.`);
console.log(`   3. Validate links with 'node .agents/skills/codebase-wiki-generator/scripts/validate-wiki-links.cjs'.\n`);
