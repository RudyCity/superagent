import { createCanvas } from "@napi-rs/canvas";
import fs from "fs";
import path from "path";

const sizes = [16, 48, 128];
const iconsDir = path.join(process.cwd(), "chrome-extension", "icons");
fs.mkdirSync(iconsDir, { recursive: true });

try {
  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    
    // Background gradient circle
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#00f2fe");
    gradient.addColorStop(1, "#9d4edd");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    
    // Glowing border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.stroke();
    
    // "S" label
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(size * 0.6)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("S", size / 2, size / 2);
    
    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buffer);
  }
  console.log("Canvas icons generated successfully.");
} catch (err) {
  console.log("Canvas drawing failed, using fallback base64 png icons...", err);
  // Fallback 1x1 transparent PNG base64
  const fallbackBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const buffer = Buffer.from(fallbackBase64, "base64");
  for (const size of sizes) {
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buffer);
  }
  console.log("Fallback icons written successfully.");
}
