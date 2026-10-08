"""OmniParser setup for Superagent vision-based UI automation.

Downloads model weights and installs Python dependencies.
Run once:  python services/omniparser/setup.py
Requires: Python 3.10+, internet connection (downloads ~1.1GB on first run).
"""
import sys
import subprocess
import os

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
MIN_DEPS = [
    "torch",
    "torchvision",
    "ultralytics==8.3.70",
    "transformers==4.47.1",
    "timm",
    "einops==0.8.0",
    "accelerate",
    "huggingface_hub",
    "supervision==0.18.0",
    "opencv-python",
    "numpy==1.26.4",
    "Pillow",
]

def run(cmd, **kw):
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kw)

def main():
    if sys.version_info < (3, 10):
        sys.exit("Python 3.10+ required, found %s" % sys.version)
    print("Installing dependencies...", flush=True)
    run([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
    run([sys.executable, "-m", "pip", "install"] + MIN_DEPS)

    print("Downloading YOLO weights...", flush=True)
    from huggingface_hub import hf_hub_download
    weights_dir = os.path.join(SERVICE_DIR, "weights", "icon_detect")
    os.makedirs(weights_dir, exist_ok=True)
    dest = os.path.join(weights_dir, "model.pt")
    if not os.path.exists(dest) or os.path.getsize(dest) < 10_000_000:
        src = hf_hub_download(
            repo_id="microsoft/OmniParser",
            filename="weights/icon_detect/model.pt",
        )
        import shutil
        shutil.copy(src, dest)
        print("YOLO weights -> %s" % dest, flush=True)
    else:
        print("YOLO weights already present.", flush=True)

    print("Downloading Florence-2 (cached by transformers)...", flush=True)
    from transformers import AutoProcessor, AutoModelForCausalLM
    AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
    AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)
    print("Florence-2 done.", flush=True)

    # Marker so control_chrome_vision knows setup is done (no re-download prompt)
    with open(os.path.join(SERVICE_DIR, ".setup_done"), "w") as mf:
        mf.write("ok\n")

    print("\nSetup complete. Start the service with:", flush=True)
    print("  python services/omniparser/omniparser_service.py", flush=True)

if __name__ == "__main__":
    main()
