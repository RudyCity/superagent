#!/usr/bin/env node

/**
 * extract-api-catalog.cjs
 * Parses backend API routes (Hono, Express, Fastify, Next.js, etc.) across
 * primary and federated workspaces, generating structured API Catalog tables.
 * 
 * Usage:
 *   node extract-api-catalog.cjs [--config <file>] [--routes-dir <dir>] [--output <file>] [--update-wiki]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let configFile = 'docs/wiki/wiki-config.json';
let routesDirs = null;
let outputFile = null;
let updateWiki = false;
let wikiPath = 'docs/wiki/03-api-and-contracts.md';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    configFile = args[++i];
  } else if (args[i] === '--routes-dir' || args[i] === '-r') {
    routesDirs = [args[++i]];
  } else if (args[i] === '--output' || args[i] === '-o') {
    outputFile = args[++i];
  } else if (args[i] === '--update-wiki' || args[i] === '-u') {
    updateWiki = true;
  } else if (args[i] === '--wiki-file' || args[i] === '-w') {
    wikiPath = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Multi-Workspace API Catalog Extractor
Usage:
  node extract-api-catalog.cjs [options]

Options:
  --config, -c <file>      Path to wiki-config.json (default: docs/wiki/wiki-config.json)
  --routes-dir, -r <dir>   Single directory containing route definitions
  --output, -o <file>      File path to write markdown table output
  --update-wiki, -u        Directly patch into docs/wiki/03-api-and-contracts.md
  --wiki-file, -w <file>   Custom path to 03-api-and-contracts.md
  --help, -h               Show this help message
    `);
    process.exit(0);
  }
}

const rootDir = process.cwd();

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

// Build workspaces list
const workspaces = [];
if (config && config.primaryWorkspace) {
  workspaces.push({
    name: config.primaryWorkspace.name || 'smart-seller',
    displayName: config.primaryWorkspace.displayName || 'Primary Core (smart-seller)',
    baseDir: path.resolve(rootDir, config.primaryWorkspace.path || '.'),
    routes: config.primaryWorkspace.routes || ['apps/api/src/routes', 'apps/api/src']
  });

  if (Array.isArray(config.federatedWorkspaces)) {
    for (const fw of config.federatedWorkspaces) {
      if (fw.path && fs.existsSync(path.resolve(rootDir, fw.path))) {
        workspaces.push({
          name: fw.name || path.basename(fw.path),
          displayName: fw.displayName || `Federated: ${fw.name}`,
          baseDir: path.resolve(rootDir, fw.path),
          routes: fw.routes || ['backend/src/routes', 'src/routes', 'routes']
        });
      }
    }
  }
} else {
  // Fallback single workspace
  workspaces.push({
    name: 'smart-seller',
    displayName: 'Primary Core (smart-seller)',
    baseDir: rootDir,
    routes: routesDirs || ['apps/api/src/routes', 'apps/api/src', 'src/routes', 'routes', 'api']
  });
}

function scanFileForRoutes(filePath, relPath, workspaceBaseDir, workspaceName) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Multi-language Route Pattern Matchers:
  // 1. JS/TS (Express, Hono, Fastify, Nest, Koa, Elysia, etc.)
  const jsRouteRegex = /(?:app|router|assistant|auth|platform|inbox|orders|products|skills|tenants|webhooks|admin|buyer|checkout|oauth|partner|cms|ticket|api|server|v1|v2)\.(get|post|put|patch|delete|all|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/i;
  // 2. Python (FastAPI, Flask, Django, Litestar)
  const pyRouteRegex = /@(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*['"`]([^'"`]+)['"`]/i;
  // 3. Go (Gin, Fiber, Echo, Chi, Standard Mux)
  const goRouteRegex = /(?:r|router|app|api|group|v1|e|mux)\.(GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(\s*['"`]([^'"`]+)['"`]/;
  // 4. Rust (Actix-web, Axum, Rocket)
  const rustRouteRegex = /(?:#\[(?:get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\]|\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(get|post|put|patch|delete))/i;
  // 5. PHP (Laravel, Symfony)
  const phpRouteRegex = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"`]([^'"`]+)['"`]/i;
  // 6. Java/Kotlin (Spring Boot, Quarkus)
  const javaRouteRegex = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/i;
  // 7. C# (.NET Minimal APIs / Controllers)
  const csharpRouteRegex = /(?:app\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]+)['"`]|\[Http(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*\])/i;

  const results = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let method = '';
    let rawPath = '';

    // Match JS/TS
    const jsMatch = line.match(jsRouteRegex);
    if (jsMatch) {
      method = jsMatch[1].toUpperCase();
      rawPath = jsMatch[2];
    }

    // Match Python
    if (!method) {
      const pyMatch = line.match(pyRouteRegex);
      if (pyMatch) {
        method = (pyMatch[1] === 'route' ? 'GET' : pyMatch[1]).toUpperCase();
        rawPath = pyMatch[2];
      }
    }

    // Match Go
    if (!method) {
      const goMatch = line.match(goRouteRegex);
      if (goMatch) {
        method = goMatch[1].toUpperCase();
        rawPath = goMatch[2];
      }
    }

    // Match Rust
    if (!method) {
      const rustMatch = line.match(rustRouteRegex);
      if (rustMatch) {
        if (rustMatch[1]) {
          method = 'GET'; // attribute macro default
          rawPath = rustMatch[1];
        } else if (rustMatch[2] && rustMatch[3]) {
          rawPath = rustMatch[2];
          method = rustMatch[3].toUpperCase();
        }
      }
    }

    // Match PHP
    if (!method) {
      const phpMatch = line.match(phpRouteRegex);
      if (phpMatch) {
        method = phpMatch[1].toUpperCase();
        rawPath = phpMatch[2];
      }
    }

    // Match Java / Spring
    if (!method) {
      const javaMatch = line.match(javaRouteRegex);
      if (javaMatch) {
        method = javaMatch[1].toUpperCase();
        rawPath = javaMatch[2];
      }
    }

    // Match C#
    if (!method) {
      const csMatch = line.match(csharpRouteRegex);
      if (csMatch) {
        method = (csMatch[1] || csMatch[3] || 'GET').toUpperCase();
        rawPath = csMatch[2] || csMatch[4] || '/';
      }
    }

    if (method && rawPath) {
      // Determine auth guard from surrounding context
      let authGuard = 'Public';
      const lineLower = line.toLowerCase();
      if (lineLower.includes('auth') || lineLower.includes('token') || lineLower.includes('guard') || lineLower.includes('jwt') || lineLower.includes('protect') || lineLower.includes('depends(get_current_user)')) {
        authGuard = 'Authenticated (JWT)';
      } else if (lineLower.includes('superadmin') || lineLower.includes('super_admin')) {
        authGuard = 'Superadmin Role';
      } else if (lineLower.includes('tenantadmin') || lineLower.includes('tenant_admin')) {
        authGuard = 'Tenant Admin';
      } else if (relPath.includes('platform') || relPath.includes('admin')) {
        authGuard = 'Platform Admin';
      } else if (lineLower.includes('partner') || relPath.includes('partner')) {
        authGuard = 'Partner Role';
      }

      let description = '';
      if (idx > 0 && (lines[idx - 1].trim().startsWith('//') || lines[idx - 1].trim().startsWith('#'))) {
        description = lines[idx - 1].trim().replace(/^(?:\/\/|#)\s*/, '');
      } else if (idx > 0 && lines[idx - 1].trim().startsWith('*')) {
        description = lines[idx - 1].trim().replace(/^\*\s*/, '');
      } else if (idx > 0 && lines[idx - 1].trim().startsWith('"""')) {
        description = lines[idx - 1].trim().replace(/^"""\s*/, '');
      }

      results.push({
        workspace: workspaceName,
        method,
        path: rawPath,
        authGuard,
        description: description || `Handler for ${method} ${rawPath}`,
        file: relPath.replace(/\\/g, '/'),
        fullPath: filePath.replace(/\\/g, '/'),
        line: idx + 1
      });
    }
  }
  return results;
}

const sourceFileExtensions = ['.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.php', '.java', '.cs'];

function traverseDir(dir, workspaceBaseDir, workspaceName) {
  const detected = [];
  if (!fs.existsSync(dir)) return detected;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== 'dist' && ent.name !== '.git' && ent.name !== '__pycache__' && ent.name !== 'target' && ent.name !== 'vendor') {
      detected.push(...traverseDir(full, workspaceBaseDir, workspaceName));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (sourceFileExtensions.includes(ext)) {
        const rel = path.relative(workspaceBaseDir, full);
        detected.push(...scanFileForRoutes(full, rel, workspaceBaseDir, workspaceName));
      }
    }
  }
  return detected;
}

console.log(`🔎 Scanning API routes across ${workspaces.length} workspace(s)...`);

const catalogByWorkspace = new Map();
let grandTotal = 0;

for (const ws of workspaces) {
  console.log(`\n📦 Scanning Workspace: ${ws.displayName} (${ws.baseDir})`);
  const wsEndpoints = [];
  for (const d of ws.routes) {
    const fullDir = path.resolve(ws.baseDir, d);
    if (fs.existsSync(fullDir)) {
      console.log(`  - Checking: ${d}`);
      wsEndpoints.push(...traverseDir(fullDir, ws.baseDir, ws.name));
    }
  }

  // Deduplicate
  const uniqueMap = new Map();
  for (const ep of wsEndpoints) {
    const key = `${ep.method}:${ep.path}:${ep.file}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, ep);
    }
  }
  const endpoints = Array.from(uniqueMap.values());
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  catalogByWorkspace.set(ws, endpoints);
  grandTotal += endpoints.length;
  console.log(`  ✅ Extracted ${endpoints.length} endpoints from ${ws.name}`);
}

console.log(`\n🎉 Total API Endpoints Discovered across all workspaces: ${grandTotal}\n`);

// Generate Markdown
let tableMd = `<!-- API_CATALOG_START -->\n`;

for (const [ws, endpoints] of catalogByWorkspace.entries()) {
  tableMd += `### 🌐 ${ws.displayName}\n\n`;
  tableMd += `| Method | Endpoint Route | Auth Guard | Description | Source File |\n`;
  tableMd += `|:---|:---|:---|:---|:---|\n`;

  for (const ep of endpoints) {
    const methodBadge = ep.method === 'GET' ? `\`GET\`` 
      : ep.method === 'POST' ? `\`POST\`` 
      : ep.method === 'PUT' ? `\`PUT\`` 
      : ep.method === 'PATCH' ? `\`PATCH\`` 
      : `\`${ep.method}\``;

    tableMd += `| ${methodBadge} | \`${ep.path}\` | ${ep.authGuard} | ${ep.description} | [${path.basename(ep.file)}:${ep.line}](file:///${ep.fullPath}#L${ep.line}) |\n`;
  }
  tableMd += `\n`;
}
tableMd += `<!-- API_CATALOG_END -->\n`;

if (outputFile) {
  fs.writeFileSync(path.resolve(rootDir, outputFile), tableMd, 'utf8');
  console.log(`💾 API catalog saved to: ${outputFile}`);
}

if (updateWiki || (!outputFile && fs.existsSync(path.resolve(rootDir, wikiPath)))) {
  const targetWiki = path.resolve(rootDir, wikiPath);
  if (fs.existsSync(targetWiki)) {
    let wikiContent = fs.readFileSync(targetWiki, 'utf8');
    if (wikiContent.includes('<!-- API_CATALOG_START -->') && wikiContent.includes('<!-- API_CATALOG_END -->')) {
      wikiContent = wikiContent.replace(
        /<!-- API_CATALOG_START -->[\s\S]*?<!-- API_CATALOG_END -->/,
        tableMd.trim()
      );
      fs.writeFileSync(targetWiki, wikiContent, 'utf8');
      console.log(`📝 Successfully patched Federated API catalog into: ${wikiPath}`);
    } else {
      wikiContent += `\n\n## Automated Route Inventory\n\n${tableMd}\n`;
      fs.writeFileSync(targetWiki, wikiContent, 'utf8');
      console.log(`📝 Appended Federated API catalog to: ${wikiPath}`);
    }
  }
}

if (!outputFile && !updateWiki) {
  console.log(tableMd);
}
