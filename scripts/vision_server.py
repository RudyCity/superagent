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

class VisionRequestHandler(BaseHTTPRequestHandler):
    @torch.inference_mode()
    def do_POST(self):
        if self.path == "/detect":
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            try:
                data = json.loads(body.decode('utf-8'))
                threshold = float(data.get('threshold', 0.35))
                
                image_base64 = data.get('image_base64')
                image_path = data.get('image_path')
                
                img = None
                if image_base64:
                    img_data = base64.b64decode(image_base64)
                    img = Image.open(io.BytesIO(img_data))
                elif image_path and os.path.exists(image_path):
                    img = Image.open(image_path)
                
                if img is None:
                    self.send_error_response("No valid image provided.")
                    return
                
                # Convert PIL Image to RGB numpy array
                img_rgb = np.array(img.convert("RGB"))
                
                # Get detector instance (instantiates on-demand)
                model = get_detector()
                detections = model.predict(img_rgb, threshold=threshold)
                
                # Format output
                elements = []
                if detections.xyxy is not None:
                    for box, score, cls_id in zip(detections.xyxy, detections.confidence, detections.class_id):
                        xmin = int(round(box[0]))
                        ymin = int(round(box[1]))
                        xmax = int(round(box[2]))
                        ymax = int(round(box[3]))
                        
                        center_x = int(round((xmin + xmax) / 2))
                        center_y = int(round((ymin + ymax) / 2))
                        
                        label = CLASSES[int(cls_id)] if int(cls_id) < len(CLASSES) else "element"
                        
                        elements.append({
                            "label": label,
                            "score": float(score),
                            "box": [xmin, ymin, xmax, ymax],
                            "center": [center_x, center_y]
                        })
                
                self.send_json_response({
                    "success": True,
                    "elements": elements
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
