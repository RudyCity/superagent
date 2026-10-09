import sys
import os
import json
import base64
import io
from http.server import HTTPServer, BaseHTTPRequestHandler
from PIL import Image
import numpy as np

# Force quick loading and silence warnings
import warnings
warnings.filterwarnings("ignore")

# Configure PyTorch CPU optimizations BEFORE importing/loading models
import torch
torch.set_num_threads(1)
torch.set_num_interop_threads(1)
torch.set_grad_enabled(False)

# Backward-compatibility shims for transformers >= 4.47 with rfdetr
import transformers
if not hasattr(transformers, "BackboneConfigMixin"):
    try:
        from transformers.utils.backbone_utils import BackboneConfigMixin, BackboneMixin
        transformers.BackboneConfigMixin = BackboneConfigMixin
        transformers.BackboneMixin = BackboneMixin
        _orig_backbone_init = BackboneMixin._init_transformers_backbone
        BackboneMixin._init_transformers_backbone = lambda self, config=None: _orig_backbone_init(
            self, config if config is not None else getattr(self, "config", None)
        )
    except Exception:
        pass

from huggingface_hub import hf_hub_download
from rfdetr.detr import RFDETRMedium

# Global model container (lazy-loaded)
detector = None
CLASSES = ['button', 'field', 'heading', 'iframe', 'image', 'label', 'link', 'text']

def get_detector():
    global detector
    if detector is None:
        print("Lazy loading RF-DETR model...")
        try:
            weights_path = hf_hub_download(repo_id="racineai/UI-DETR-1", filename="model.pth")
            detector = RFDETRMedium(pretrain_weights=weights_path, resolution=1600)
            import gc
            gc.collect()
            print("Model loaded successfully!")
        except Exception as e:
            print(f"Error lazy loading model: {e}")
            raise e
    return detector

from PIL import ImageDraw, ImageFont

def annotate_som(img: Image.Image, elements: list) -> str:
    """Renders Set-of-Mark (SoM) bounding boxes and numbered badge tags onto image."""
    annotated = img.copy().convert("RGBA")
    overlay = Image.new("RGBA", annotated.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = ImageFont.load_default()

    COLORS = {
        'button': (26, 115, 232, 230),   # Material Blue
        'field': (30, 142, 62, 230),     # Material Green
        'link': (147, 52, 230, 230),     # Purple
        'text': (18, 181, 203, 210),     # Cyan
        'heading': (227, 116, 0, 230),   # Amber/Orange
        'image': (217, 48, 37, 210),     # Red
        'default': (95, 99, 104, 210)    # Gray
    }

    for el in elements:
        eid = el.get("id", 1)
        label = el.get("label", "element")
        xmin, ymin, xmax, ymax = el.get("box", [0, 0, 0, 0])
        color = COLORS.get(label, COLORS['default'])
        solid_color = (color[0], color[1], color[2], 255)

        # Draw 2px bounding box
        draw.rectangle([xmin, ymin, xmax, ymax], outline=solid_color, width=2)

        # Badge tag: "[id] label"
        badge_text = f"[{eid}] {label}"
        bbox = font.getbbox(badge_text) if hasattr(font, 'getbbox') else (0, 0, len(badge_text) * 6, 11)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]

        # Place badge at top-left of box
        bx1 = max(0, xmin)
        by1 = max(0, ymin - th - 5)
        bx2 = bx1 + tw + 6
        by2 = by1 + th + 4
        draw.rectangle([bx1, by1, bx2, by2], fill=solid_color)
        draw.text((bx1 + 3, by1 + 1), badge_text, fill=(255, 255, 255, 255), font=font)

    composed = Image.alpha_composite(annotated, overlay).convert("RGB")
    buf = io.BytesIO()
    composed.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

class VisionRequestHandler(BaseHTTPRequestHandler):
    @torch.inference_mode()
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if self.path in ("/detect", "/perceive"):
            try:
                data = json.loads(body.decode('utf-8'))
                threshold = float(data.get('threshold', 0.35))
                annotate = bool(data.get('annotate', self.path == "/perceive"))
                
                image_base64 = data.get('image_base64')
                image_path = data.get('image_path')
                
                img = None
                if image_base64:
                    cleaned_b64 = image_base64.replace("data:image/png;base64,", "").replace("data:image/jpeg;base64,", "")
                    img_data = base64.b64decode(cleaned_b64)
                    img = Image.open(io.BytesIO(img_data))
                elif image_path and os.path.exists(image_path):
                    img = Image.open(image_path)
                
                if img is None:
                    self.send_error_response("No valid image provided.")
                    return
                
                img_rgb = np.array(img.convert("RGB"))
                model = get_detector()
                detections = model.predict(img_rgb, threshold=threshold)
                
                elements = []
                if detections.xyxy is not None:
                    idx = 1
                    for box, score, cls_id in zip(detections.xyxy, detections.confidence, detections.class_id):
                        xmin = int(round(box[0]))
                        ymin = int(round(box[1]))
                        xmax = int(round(box[2]))
                        ymax = int(round(box[3]))
                        
                        center_x = int(round((xmin + xmax) / 2))
                        center_y = int(round((ymin + ymax) / 2))
                        
                        label = CLASSES[int(cls_id)] if int(cls_id) < len(CLASSES) else "element"
                        
                        elements.append({
                            "id": idx,
                            "label": label,
                            "score": float(round(score, 4)),
                            "box": [xmin, ymin, xmax, ymax],
                            "center": [center_x, center_y]
                        })
                        idx += 1
                
                resp = {
                    "success": True,
                    "elements": elements
                }

                if annotate:
                    resp["annotated_image"] = annotate_som(img, elements)

                self.send_json_response(resp)
            except Exception as e:
                self.send_error_response(str(e))

        elif self.path == "/diff":
            try:
                data = json.loads(body.decode('utf-8'))
                b64_before = data.get('image_before', '').replace("data:image/png;base64,", "")
                b64_after = data.get('image_after', '').replace("data:image/png;base64,", "")
                
                if not b64_before or not b64_after:
                    self.send_error_response("Both image_before and image_after are required.")
                    return
                
                img1 = np.array(Image.open(io.BytesIO(base64.b64decode(b64_before))).convert("RGB"))
                img2 = np.array(Image.open(io.BytesIO(base64.b64decode(b64_after))).convert("RGB"))
                
                # Check dimensional match
                if img1.shape != img2.shape:
                    self.send_json_response({
                        "success": True,
                        "changed": True,
                        "diff_ratio": 1.0,
                        "note": "Page dimension or viewport changed"
                    })
                    return
                
                # Compute absolute pixel difference ratio
                diff = np.abs(img1.astype(float) - img2.astype(float))
                changed_pixels = np.count_nonzero(np.max(diff, axis=2) > 15)
                total_pixels = img1.shape[0] * img1.shape[1]
                ratio = float(round(changed_pixels / max(1, total_pixels), 4))
                
                self.send_json_response({
                    "success": True,
                    "changed": ratio > 0.005,
                    "diff_ratio": ratio
                })
            except Exception as e:
                self.send_error_response(str(e))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            
    def do_GET(self):
        if self.path == "/health":
            self.send_json_response({
                "status": "healthy",
                "model_loaded": detector is not None
            })
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

    def send_json_response(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))
        
    def send_error_response(self, message):
        self.send_response(500)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode('utf-8'))

    def log_message(self, format, *args):
        # Silence standard HTTP access logging to avoid terminal clutter
        pass

def run(port=8095):
    server_address = ('127.0.0.1', port)
    try:
        from http.server import ThreadingHTTPServer
        httpd = ThreadingHTTPServer(server_address, VisionRequestHandler)
    except ImportError:
        httpd = HTTPServer(server_address, VisionRequestHandler)
    print(f"Vision Server running locally on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    print("Stopping Vision Server...")

if __name__ == '__main__':
    port = 8095
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run(port)
