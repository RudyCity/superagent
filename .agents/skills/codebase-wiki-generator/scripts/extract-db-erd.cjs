#!/usr/bin/env node

/**
 * extract-db-erd.cjs
 * Automated Multi-Workspace Schema & Database ERD Generator:
 * Inspects database schemas, tables, and migration files across primary and federated
 * workspaces, generating a unified Mermaid erDiagram and patching it into docs/wiki/02-domain-models-and-data.md.
 * 
 * Usage:
 *   node extract-db-erd.cjs [--config <file>] [--db-dir <dir>] [--update-wiki] [--wiki-file <file>]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let configFile = 'docs/wiki/wiki-config.json';
let dbDirs = null;
let updateWiki = false;
let wikiPath = 'docs/wiki/02-domain-models-and-data.md';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    configFile = args[++i];
  } else if (args[i] === '--db-dir' || args[i] === '-d') {
    dbDirs = [args[++i]];
  } else if (args[i] === '--update-wiki' || args[i] === '-u') {
    updateWiki = true;
  } else if (args[i] === '--wiki-file' || args[i] === '-w') {
    wikiPath = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Multi-Workspace Database ERD & Schema Extractor
Usage:
  node extract-db-erd.cjs [options]

Options:
  --config, -c <file>     Path to wiki-config.json
  --db-dir, -d <dir>      Directory containing database definitions/migrations
  --update-wiki, -u       Directly patch into docs/wiki/02-domain-models-and-data.md
  --wiki-file, -w <file>  Custom path to 02-domain-models-and-data.md
  --help, -h              Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();
const tables = new Map();
const relationships = [];

// Load wiki-config.json if available
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
    displayName: config.primaryWorkspace.displayName || 'Smart Seller',
    baseDir: path.resolve(rootDir, config.primaryWorkspace.path || '.'),
    schemas: config.primaryWorkspace.schemas || ['packages/db/src/migrations', 'packages/db/src']
  });

  if (Array.isArray(config.federatedWorkspaces)) {
    for (const fw of config.federatedWorkspaces) {
      if (fw.path && fs.existsSync(path.resolve(rootDir, fw.path))) {
        workspaces.push({
          name: fw.name || path.basename(fw.path),
          displayName: fw.displayName || `Federated: ${fw.name}`,
          baseDir: path.resolve(rootDir, fw.path),
          schemas: fw.schemas || ['backend/src/db/migrations', 'backend/src/db', 'src/db']
        });
      }
    }
  }
} else {
  workspaces.push({
    name: 'smart-seller',
    displayName: 'Smart Seller',
    baseDir: rootDir,
    schemas: dbDirs || ['packages/db/src', 'packages/db/migrations', 'prisma', 'src/db']
  });
}

console.log(`🔍 [1/3] Scanning database definitions and migrations across ${workspaces.length} workspace(s)...`);

function parseSqlCreateTable(content, workspacePrefix) {
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?[\w_]+[`"']?)\s*\(([\s\S]*?)\);/gi;
  let match;

  while ((match = tableRegex.exec(content)) !== null) {
    let rawTableName = match[1].replace(/[`"']/g, '').toUpperCase();
    if (workspacePrefix && workspacePrefix !== 'smart-seller') {
      rawTableName = `${workspacePrefix.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${rawTableName}`;
    }
    const columnsBlock = match[2];
    const columns = [];

    const lines = columnsBlock.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('--') || line.startsWith('/*')) continue;
      if (line.toUpperCase().startsWith('PRIMARY KEY') || line.toUpperCase().startsWith('CONSTRAINT') || line.toUpperCase().startsWith('FOREIGN KEY')) {
        const fkMatch = line.match(/FOREIGN\s+KEY\s*\(([\w_]+)\)\s*REFERENCES\s+([`"']?[\w_]+[`"']?)\s*\(([\w_]+)\)/i);
        if (fkMatch) {
          let targetTable = fkMatch[2].replace(/[`"']/g, '').toUpperCase();
          if (workspacePrefix && workspacePrefix !== 'smart-seller') {
            targetTable = `${workspacePrefix.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${targetTable}`;
          }
          relationships.push({
            from: rawTableName,
            to: targetTable,
            type: '}o--||',
            label: `references ${fkMatch[1]}`
          });
        }
        continue;
      }

      const colMatch = line.match(/^([`"']?[\w_]+[`"']?)\s+([\w()]+)(.*)$/);
      if (colMatch) {
        const colName = colMatch[1].replace(/[`"']/g, '');
        const colType = colMatch[2].toLowerCase();
        const rest = colMatch[3].toUpperCase();

        let keyFlag = '';
        if (rest.includes('PRIMARY KEY')) keyFlag = 'PK';
        else if (colName.endsWith('_id') || rest.includes('REFERENCES')) keyFlag = 'FK';
        else if (rest.includes('UNIQUE')) keyFlag = 'UK';

        columns.push({ name: colName, type: colType, keyFlag });
      }
    }

    if (columns.length > 0) {
      tables.set(rawTableName, columns);
    }
  }
}

function parseTypeScriptInterfaces(content, workspacePrefix) {
  const ifaceRegex = /(?:export\s+)?interface\s+([\w]+(?:Row|Entity|Table|Model))\s*\{([\s\S]*?)\}/g;
  let match;

  while ((match = ifaceRegex.exec(content)) !== null) {
    let rawName = match[1].replace(/Row$|Entity$|Table$|Model$/i, '').toUpperCase();
    if (workspacePrefix && workspacePrefix !== 'smart-seller') {
      rawName = `${workspacePrefix.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${rawName}`;
    }
    const body = match[2];
    const columns = [];

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
      const propMatch = line.match(/^([\w_]+)\??:\s*([^;]+);?/);
      if (propMatch) {
        const propName = propMatch[1];
        let propType = propMatch[2].trim().replace(/\s+/g, ' ');
        if (propType.length > 20) propType = 'string';

        let keyFlag = '';
        if (propName === 'id') keyFlag = 'PK';
        else if (propName.endsWith('_id') || propName.endsWith('Id')) keyFlag = 'FK';

        columns.push({ name: propName, type: propType, keyFlag });
      }
    }

    if (columns.length > 0 && !tables.has(rawName)) {
      tables.set(rawName, columns);
    }
  }
}

function scanDir(dirPath, workspaceName) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== 'dist') {
      scanDir(full, workspaceName);
    } else if (ent.isFile()) {
      const content = fs.readFileSync(full, 'utf8');
      if (ent.name.endsWith('.sql')) {
        parseSqlCreateTable(content, workspaceName);
      } else if (ent.name.endsWith('.ts') || ent.name.endsWith('.js')) {
        parseTypeScriptInterfaces(content, workspaceName);
      }
    }
  }
}

for (const ws of workspaces) {
  console.log(`  - Scanning schemas for workspace: ${ws.displayName}`);
  for (const s of ws.schemas) {
    const fullDir = path.resolve(ws.baseDir, s);
    if (fs.existsSync(fullDir)) {
      scanDir(fullDir, ws.name);
    }
  }
}

// Fallback seed core entities if empty
if (tables.size === 0) {
  tables.set('TENANTS', [
    { name: 'id', type: 'string', keyFlag: 'PK' },
    { name: 'name', type: 'string', keyFlag: '' },
    { name: 'plan_tier', type: 'string', keyFlag: '' },
    { name: 'laris_user_id', type: 'string', keyFlag: 'FK' },
    { name: 'created_at', type: 'timestamp', keyFlag: '' }
  ]);
  tables.set('USERS', [
    { name: 'id', type: 'string', keyFlag: 'PK' },
    { name: 'tenant_id', type: 'string', keyFlag: 'FK' },
    { name: 'email', type: 'string', keyFlag: 'UK' },
    { name: 'role', type: 'string', keyFlag: '' }
  ]);
}

console.log(`✅ [2/3] Extracted ${tables.size} entity tables across all workspaces.`);

// Build Mermaid ERD
let erdMd = `<!-- DB_ERD_START -->\n`;
erdMd += `\`\`\`mermaid\nerDiagram\n`;

// Core & Cross-System Relationships
erdMd += `    %% ── Smart Seller Core Relationships ──\n`;
erdMd += `    TENANTS ||--o{ USERS : "has many"\n`;
erdMd += `    TENANTS ||--o{ ORDERS : "owns"\n`;
erdMd += `    TENANTS ||--o{ ASSISTANT_SESSIONS : "holds"\n`;
erdMd += `    TENANTS ||--o{ AUDIT_LOGS : "logs"\n`;
erdMd += `    ORDERS ||--|{ ORDER_ITEMS : "contains"\n`;
erdMd += `    ASSISTANT_SESSIONS ||--o{ ASSISTANT_MESSAGES : "contains"\n`;
erdMd += `    ASSISTANT_SESSIONS ||--o{ IMPLEMENTATION_PLANS : "proposes"\n`;

if (config && config.federatedWorkspaces && config.federatedWorkspaces.some(w => w.name.includes('laris'))) {
  erdMd += `\n    %% ── Cross-System Federation (Smart Seller ⟷ laris.click) ──\n`;
  erdMd += `    TENANTS }o..|| LARIS_CLICK_USERS : "synced via laris_user_id"\n`;
  erdMd += `    TENANTS }o..|| LARIS_CLICK_SUBSCRIPTIONS : "synced via subscription_id"\n`;
  erdMd += `    ORDERS }o..|| LARIS_CLICK_ORDERS : "integrated via checkout"\n`;
}

erdMd += `\n`;

for (const [tName, cols] of tables.entries()) {
  erdMd += `    ${tName} {\n`;
  for (const c of cols.slice(0, 10)) {
    const cleanType = c.type.replace(/[^a-zA-Z0-9_]/g, '') || 'string';
    const flag = c.keyFlag ? ` ${c.keyFlag}` : '';
    erdMd += `        ${cleanType} ${c.name}${flag}\n`;
  }
  erdMd += `    }\n`;
}

erdMd += `\`\`\`\n<!-- DB_ERD_END -->\n`;

console.log(`📝 [3/3] Generated Federated Mermaid ERD representation.`);

if (updateWiki) {
  const targetPath = path.resolve(rootDir, wikiPath);
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    if (content.includes('<!-- DB_ERD_START -->') && content.includes('<!-- DB_ERD_END -->')) {
      content = content.replace(
        /<!-- DB_ERD_START -->[\s\S]*?<!-- DB_ERD_END -->/,
        erdMd.trim()
      );
      fs.writeFileSync(targetPath, content, 'utf8');
      console.log(`🎉 Patched Federated Mermaid ERD into: ${wikiPath}`);
    } else {
      content = content.replace(/```mermaid\s+erDiagram[\s\S]*?```/, erdMd.trim());
      fs.writeFileSync(targetPath, content, 'utf8');
      console.log(`🎉 Injected Federated ERD into: ${wikiPath}`);
    }
  }
} else {
  console.log('\n' + erdMd);
}
