import fg from 'fast-glob';
import path from 'path';

async function run() {
  const targetCwd = "D:/backup from pc asus/Documents Development/superagent/.worktrees/feat-test";
  console.log('Testing fg in worktree:', targetCwd);
  try {
    const files = await fg('**/*', {
      cwd: targetCwd,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
    console.log(`Found ${files.length} files.`);
    console.log('Sample files:', files.slice(0, 5));
  } catch (e) {
    console.error(e);
  }
}

run();
