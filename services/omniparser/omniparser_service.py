"""
OmniParser HTTP Service for Superagent vision-based UI automation.
Listens on 127.0.0.1:9333 (localhost only, never expose to network).
"""
import sys
import os
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SERVICE_DIR)

import io
import base64
import json
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from PIL import Image

omniparser = None
load_error = None

def load_model():
    global omniparser, load_error
    try:
        from util.omniparser import Omniparser
        config = {
            'som_model_path': os.path.join(SERVICE_DIR, 'weights', 'icon_detect', 'model.pt'),
            'caption_model_name': 'florence2',
            'caption_model_path': 'microsoft/Florence-2-base',
            'BOX_TRESHOLD': 0.05,
        }
        print('Loading OmniParser models...', flush=True)
        omniparser = Omniparser(config)
        print('OmniParser ready!', flush=True)
    except Exception as e:
        load_error = str(e)
        print('Model load failed: %s' % e, flush=True)
        traceback.print_exc()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print('%s - %s' % (self.client_address[0], format % args), flush=True)

    def do_GET(self):
        if self.path == '/health':
            status = 'ready' if omniparser else 'loading_failed: %s' % load_error
            self._send_json({'status': status})
        else:
            self._send_json({'error': 'not found'}, 404)

    def do_POST(self):
        if self.path != '/parse':
            self._send_json({'error': 'not found'}, 404)
            return
        if not omniparser:
            self._send_json({'error': 'model not loaded: %s' % load_error}, 503)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            img_b64 = data.get('image_base64') or data.get('image')
            if not img_b64:
                self._send_json({'error': 'missing image_base64'}, 400)
                return
            if ',' in img_b64 and img_b64.startswith('data:'):
                img_b64 = img_b64.split(',', 1)[1]
            img_bytes = base64.b64decode(img_b64)
            img = Image.open(io.BytesIO(img_bytes))
            W, H = img.size
            _, parsed = omniparser.parse(img_b64)
            elements = []
            for i, item in enumerate(parsed):
                bbox = item.get('bbox')
                if not bbox or len(bbox) < 4:
                    continue
                x1, y1, x2, y2 = bbox[:4]
                if max(x1, y1, x2, y2) <= 1.0:
                    x1, y1, x2, y2 = x1*W, y1*H, x2*W, y2*H
                elements.append({
                    'id': i,
                    'x': int((x1+x2)/2), 'y': int((y1+y2)/2),
                    'x1': int(x1), 'y1': int(y1),
                    'x2': int(x2), 'y2': int(y2),
                    'width': int(x2-x1), 'height': int(y2-y1),
                    'label': item.get('content') or '',
                    'type': item.get('type') or 'unknown',
                })
            self._send_json({'elements': elements, 'width': W, 'height': H})
        except Exception as e:
            traceback.print_exc()
            self._send_json({'error': str(e)}, 500)

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    load_model()
    server = HTTPServer(('127.0.0.1', 9333), Handler)
    print('OmniParser service on http://127.0.0.1:9333', flush=True)
    server.serve_forever()
