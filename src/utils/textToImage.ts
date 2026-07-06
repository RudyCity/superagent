import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";

const psScript = `
  Add-Type -AssemblyName System.Drawing;
  $textPath = $args[0];
  $outputPath = $args[1];
  
  $text = [System.IO.File]::ReadAllText($textPath);
  $font = New-Object System.Drawing.Font("Consolas", 11);
  
  # Measure text bounds
  $tempBmp = New-Object System.Drawing.Bitmap 1, 1;
  $gTemp = [System.Drawing.Graphics]::FromImage($tempBmp);
  $size = $gTemp.MeasureString($text, $font);
  $gTemp.Dispose();
  $tempBmp.Dispose();
  
  $width = [Math]::Max(600, [Math]::Ceiling($size.Width) + 30);
  $height = [Math]::Ceiling($size.Height) + 30;
  
  $bmp = New-Object System.Drawing.Bitmap $width, $height;
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $g.Clear([System.Drawing.Color]::FromArgb(30, 30, 30));
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 220, 220));
  $g.DrawString($text, $font, $brush, 15, 15);
  
  $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png);
  
  $brush.Dispose();
  $g.Dispose();
  $bmp.Dispose();
`;

const pythonScript = `
import sys
import os
from PIL import Image, ImageDraw, ImageFont

text_path = sys.argv[1]
output_path = sys.argv[2]

with open(text_path, "r", encoding="utf-8") as f:
    text = f.read()

font = None
for font_name in ["DejaVuSansMono.ttf", "Courier.dfont", "LiberationMono-Regular.ttf", "Courier New.ttf"]:
    try:
        font = ImageFont.truetype(font_name, 14)
        break
    except:
        pass

if font is None:
    font = ImageFont.load_default()

img = Image.new("RGB", (1, 1))
draw = ImageDraw.Draw(img)
try:
    bbox = draw.textbbox((0, 0), text, font=font)
    width = max(600, bbox[2] - bbox[0] + 30)
    height = bbox[3] - bbox[1] + 30
except AttributeError:
    w, h = draw.textsize(text, font=font)
    width = max(600, w + 30)
    height = h + 30

img = Image.new("RGB", (width, height), color=(30, 30, 30))
draw = ImageDraw.Draw(img)
draw.text((15, 15), text, fill=(220, 220, 220), font=font)
img.save(output_path)
`;

/**
 * Slice text into readable pages
 */
export function sliceTextIntoPages(text: string, maxLines = 150, maxPages = 3): string[] {
  const lines = text.split(/\r?\n/);
  const pages: string[] = [];
  
  for (let i = 0; i < lines.length && pages.length < maxPages; i += maxLines) {
    const chunk = lines.slice(i, i + maxLines).join("\n");
    pages.push(chunk);
  }
  
  if (lines.length > maxLines * maxPages) {
    const remaining = lines.length - (maxLines * maxPages);
    pages[pages.length - 1] += `\n\n--- [TRUNCATED - Remaining ${remaining} lines not shown to save context tokens] ---`;
  }
  
  return pages;
}

/**
 * Render a text chunk into a PNG image synchronously and return its base64 data.
 */
export function renderTextToImageBase64(text: string): string {
  const tempId = crypto.randomUUID();
  const tempTextFile = path.join(os.tmpdir(), `superagent-text-${tempId}.txt`);
  const tempImageFile = path.join(os.tmpdir(), `superagent-image-${tempId}.png`);
  
  try {
    fs.writeFileSync(tempTextFile, text, "utf-8");
    
    if (process.platform === "win32") {
      // Use PowerShell to render
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript, tempTextFile, tempImageFile], { stdio: "ignore" });
    } else {
      // Use Python with Pillow
      const tempPyFile = path.join(os.tmpdir(), `superagent-py-${tempId}.py`);
      fs.writeFileSync(tempPyFile, pythonScript, "utf-8");
      try {
        execFileSync("python3", [tempPyFile, tempTextFile, tempImageFile], { stdio: "ignore" });
      } finally {
        try { fs.unlinkSync(tempPyFile); } catch {}
      }
    }
    
    // Read the rendered image
    const imageBuffer = fs.readFileSync(tempImageFile);
    return imageBuffer.toString("base64");
  } finally {
    // Cleanup temporary files
    try { fs.unlinkSync(tempTextFile); } catch {}
    try { fs.unlinkSync(tempImageFile); } catch {}
  }
}
