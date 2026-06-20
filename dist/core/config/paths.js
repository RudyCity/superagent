import fs from "fs";
import path from "path";
import os from "os";
export function getRootConfigDir() {
    return path.join(os.homedir(), ".superagent-r");
}
export function getGlobalConfigDir() {
    const root = getRootConfigDir();
    if (process.env.SUPERAGENT_SESSION_ID) {
        return path.join(root, "sessions", process.env.SUPERAGENT_SESSION_ID);
    }
    return root;
}
export function ensureGlobalConfigDir() {
    const rootDir = getRootConfigDir();
    if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir, { recursive: true });
    }
    const dir = getGlobalConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const historyDir = path.join(dir, "history");
    if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
    }
    const singleDir = path.join(historyDir, "single");
    if (!fs.existsSync(singleDir)) {
        fs.mkdirSync(singleDir, { recursive: true });
    }
    const multiDir = path.join(historyDir, "multi");
    if (!fs.existsSync(multiDir)) {
        fs.mkdirSync(multiDir, { recursive: true });
    }
    const checkpointsDir = path.join(dir, "checkpoints");
    if (!fs.existsSync(checkpointsDir)) {
        fs.mkdirSync(checkpointsDir, { recursive: true });
    }
}
export function getModelConfigPath() {
    return path.join(getRootConfigDir(), "model-config.json");
}
//# sourceMappingURL=paths.js.map