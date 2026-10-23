import type { MotionProject } from "../schema/types.js";
import type { MotionJob } from "../jobs/motionJobs.js";

/**
 * Generates a self-contained, offline-capable HTML5 player & frame scrubber
 * for Superagent Studio projects.
 * Adheres to Antislop and premium design-taste standards: clean dark theme,
 * crisp typography, glowing cyan/magenta accents, and zero external CDN deps.
 */
export function renderMotionPlayerHtml(
  project: MotionProject,
  latestJob?: MotionJob,
): string {
  const c = project.composition;
  const fps = c.fps.numerator / c.fps.denominator;
  const durationSec = (c.durationFrames / fps).toFixed(1);
  const aspect = c.width === c.height ? "1:1" : c.height > c.width ? "9:16" : "16:9";

  const layersJson = JSON.stringify(c.layers, null, 2);
  const audioTracksJson = JSON.stringify(c.audioTracks || [], null, 2);
  const artifactUrl = latestJob?.status === "completed"
    ? `/api/motion/jobs/${latestJob.id}/artifact`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.name)} — Superagent Studio Player</title>
  <style>
    :root {
      --bg-dark: #0B0F19;
      --bg-panel: #111827;
      --bg-card: #1F2937;
      --border: #374151;
      --text: #F3F4F6;
      --text-muted: #9CA3AF;
      --accent-cyan: #38BDF8;
      --accent-magenta: #F43F5E;
      --accent-green: #10B981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-dark);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-title h1 {
      font-size: 1.25rem;
      font-weight: 700;
      color: #FFFFFF;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent-cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .badge-green {
      background: rgba(16, 185, 129, 0.15);
      color: var(--accent-green);
      border-color: rgba(16, 185, 129, 0.3);
    }
    .meta-tags {
      display: flex;
      gap: 8px;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    main {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 360px;
      gap: 24px;
      padding: 24px;
      max-width: 1440px;
      margin: 0 auto;
      width: 100%;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
    }
    .player-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .viewport-container {
      background: #000000;
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      aspect-ratio: ${aspect === "9:16" ? "9/16" : aspect === "1:1" ? "1/1" : "16/9"};
      max-height: 540px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    video, .frame-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .controls-panel {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .timeline-scrubber {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .timeline-bar {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--accent-cyan);
      cursor: pointer;
    }
    .button-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .btn-group {
      display: flex;
      gap: 6px;
    }
    button, .link-btn {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    button:hover, .link-btn:hover {
      background: var(--border);
      color: #FFFFFF;
      border-color: var(--accent-cyan);
    }
    button.primary, .link-btn.primary {
      background: var(--accent-cyan);
      color: #000000;
      font-weight: 600;
      border: none;
    }
    button.primary:hover, .link-btn.primary:hover {
      background: #7dd3fc;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card h3 {
      font-size: 0.9rem;
      color: #FFFFFF;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .layer-list {
      max-height: 240px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .layer-item {
      background: var(--bg-card);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 0.75rem;
      display: flex;
      justify-content: space-between;
    }
    .layer-id { font-family: monospace; color: var(--accent-cyan); }
    .layer-kind { color: var(--text-muted); }
    .status-msg {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.4;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 14px 24px;
      font-size: 0.75rem;
      color: var(--text-muted);
      text-align: center;
      margin-top: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-title">
      <h1>${escapeHtml(project.name)}</h1>
      <span class="badge">Rev ${project.revision}</span>
      <span class="badge badge-green">${escapeHtml(aspect)}</span>
    </div>
    <div class="meta-tags">
      <span>${c.width}×${c.height}</span>
      <span>•</span>
      <span>${durationSec}s (${c.durationFrames} frames @ ${fps} fps)</span>
    </div>
  </header>

  <main>
    <div class="player-section">
      <div class="viewport-container" id="viewport">
        ${
          artifactUrl
            ? `<video id="videoPlayer" src="${artifactUrl}" controls autoplay loop></video>`
            : `<img id="frameImg" class="frame-img" src="/api/motion/projects/${project.id}/frames/0.png" alt="Frame preview">`
        }
      </div>

      <div class="controls-panel">
        <div class="timeline-scrubber">
          <div class="timeline-bar">
            <span>Frame Scrubber: <strong id="currentFrameText">0</strong> / ${c.durationFrames - 1}</span>
            <span id="timecodeText">0.00s</span>
          </div>
          <input type="range" id="frameSlider" min="0" max="${c.durationFrames - 1}" value="0">
        </div>

        <div class="button-row">
          <div class="btn-group">
            <button id="btnPrevFrame" title="Previous frame">◄ -1</button>
            <button id="btnPlayPause" class="primary">Play / Pause</button>
            <button id="btnNextFrame" title="Next frame">+1 ►</button>
          </div>
          <div class="btn-group">
            ${
              artifactUrl
                ? `<a class="link-btn primary" href="${artifactUrl}" download="video-${project.id}.mp4">Download MP4</a>`
                : `<span class="badge">Render in progress</span>`
            }
            <a class="link-btn" href="/api/motion/projects/${project.id}/captions.srt" download="captions.srt">Export .SRT</a>
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar">
      <div class="card">
        <h3>Project Artifacts</h3>
        <p class="status-msg">
          ${
            latestJob?.status === "completed"
              ? `Video is compiled and verified with FFmpeg (${((latestJob.artifact?.bytes || 0) / 1024).toFixed(1)} KB).`
              : "Render job is in progress or awaiting worker dispatch."
          }
        </p>
        <div class="btn-group" style="flex-wrap: wrap;">
          ${
            latestJob?.status === "completed"
              ? `<a class="link-btn" href="/api/motion/jobs/${latestJob.id}/exports/webm" download>Export WebM</a>
                 <a class="link-btn" href="/api/motion/jobs/${latestJob.id}/exports/gif" download>Export GIF</a>`
              : ""
          }
        </div>
      </div>

      <div class="card">
        <h3>Composition Layers (${c.layers.length})</h3>
        <div class="layer-list" id="layerList">
          ${c.layers
            .map(
              l => `
            <div class="layer-item">
              <span class="layer-id">${escapeHtml(l.id)}</span>
              <span class="layer-kind">${escapeHtml(l.kind)}</span>
            </div>
          `,
            )
            .join("")}
        </div>
      </div>

      <div class="card">
        <h3>Audio & Voiceover</h3>
        <p class="status-msg">
          ${
            (c.audioTracks || []).length > 0
              ? `Attached tracks: ${c.audioTracks?.map(t => `${t.role} (vol: ${t.volume})`).join(", ")}`
              : "No background music attached."
          }
        </p>
      </div>
    </div>
  </main>

  <footer>
    Superagent Studio Standalone Player • Offline Engine
  </footer>

  <script>
    const totalFrames = ${c.durationFrames};
    const fps = ${fps};
    const projectId = "${project.id}";
    const video = document.getElementById("videoPlayer");
    const frameImg = document.getElementById("frameImg");
    const slider = document.getElementById("frameSlider");
    const currentFrameText = document.getElementById("currentFrameText");
    const timecodeText = document.getElementById("timecodeText");
    const btnPlayPause = document.getElementById("btnPlayPause");
    const btnPrev = document.getElementById("btnPrevFrame");
    const btnNext = document.getElementById("btnNextFrame");

    function updateDisplay(frame) {
      slider.value = frame;
      currentFrameText.textContent = frame;
      timecodeText.textContent = (frame / fps).toFixed(2) + "s";
      if (frameImg) {
        frameImg.src = "/api/motion/projects/" + projectId + "/frames/" + frame + ".png";
      }
    }

    if (video) {
      video.addEventListener("timeupdate", () => {
        const frame = Math.min(totalFrames - 1, Math.floor(video.currentTime * fps));
        slider.value = frame;
        currentFrameText.textContent = frame;
        timecodeText.textContent = video.currentTime.toFixed(2) + "s";
      });
      btnPlayPause.addEventListener("click", () => {
        if (video.paused) video.play();
        else video.pause();
      });
      slider.addEventListener("input", (e) => {
        const f = Number(e.target.value);
        video.currentTime = f / fps;
        currentFrameText.textContent = f;
        timecodeText.textContent = (f / fps).toFixed(2) + "s";
      });
      btnPrev.addEventListener("click", () => {
        video.currentTime = Math.max(0, video.currentTime - (1 / fps));
      });
      btnNext.addEventListener("click", () => {
        video.currentTime = Math.min(totalFrames / fps, video.currentTime + (1 / fps));
      });
    } else {
      let currentFrame = 0;
      let isPlaying = false;
      let playTimer = null;

      slider.addEventListener("input", (e) => {
        currentFrame = Number(e.target.value);
        updateDisplay(currentFrame);
      });

      btnPrev.addEventListener("click", () => {
        currentFrame = Math.max(0, currentFrame - 1);
        updateDisplay(currentFrame);
      });

      btnNext.addEventListener("click", () => {
        currentFrame = Math.min(totalFrames - 1, currentFrame + 1);
        updateDisplay(currentFrame);
      });

      btnPlayPause.addEventListener("click", () => {
        if (isPlaying) {
          clearInterval(playTimer);
          isPlaying = false;
          btnPlayPause.textContent = "Play";
        } else {
          isPlaying = true;
          btnPlayPause.textContent = "Pause";
          playTimer = setInterval(() => {
            currentFrame = (currentFrame + 1) % totalFrames;
            updateDisplay(currentFrame);
          }, 1000 / fps);
        }
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
