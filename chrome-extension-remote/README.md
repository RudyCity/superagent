# Superagent Remote Chrome Extension

Standalone, lightweight Chrome extension (Manifest V3) for remote controlling Google Chrome directly from the `superagent` CLI without requiring `superagent --server` or mounting the full sidepanel GUI.

---

## 🌟 Key Features

* **Serverless CLI Integration**: Communicates directly with the `superagent` CLI via an auto-initialized WebSocket bridge on port `9223`.
* **Zero Overhead**: Minimal background service worker footprint with no heavy DOM/UI rendering overhead.
* **100% Tool Suite Support**: Supports all 15 browser automation tools in Superagent:
  * Profile scanning & launching
  * Tab management & DOM text/Markdown extraction
  * Fullpage screenshot & DOM PDF/HTML capturing
  * Bookmarks, browsing history, & download management
  * Console JS error logs & network XHR/Fetch traffic monitoring
  * Cookies, `localStorage`, & `sessionStorage` management
  * Device emulation & viewport configuration (iPhone, Android, iPad)
  * Network throttling (Slow 3G, Fast 3G, Offline) & resource blocking (Images/Ads)

---

## 🛠️ Installation Guide

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Turn ON **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory:
   ```text
   chrome-extension-remote/
   ```
5. Click on the extension icon in the Chrome toolbar to verify connection status.

---

## ⚙️ Architecture Overview

```text
+-----------------------+     WebSocket (ws://127.0.0.1:9223)     +--------------------------------+
|    Superagent CLI     | <=====================================> | Superagent Remote Chrome Ext   |
| (remoteChromeBridge)  |                                         | (chrome-extension-remote)      |
+-----------------------+                                         +--------------------------------+
```

* **WebSocket Port**: `9223` (Default serverless bridge port).
* **Manifest Version**: Manifest V3 compliant.
* **Permissions**: `tabs`, `activeTab`, `scripting`, `storage`, `webNavigation`, `bookmarks`, `history`, `downloads`.
