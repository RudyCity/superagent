import sys
import json
import argparse
from PIL import Image

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Path to screenshot image")
    parser.add_argument("--threshold", type=float, default=0.35, help="Confidence threshold")
    args = parser.parse_args()

    try:
        from transformers import pipeline
    except ImportError:
        print(json.dumps({"error": "Missing dependency: transformers. Install via pip install transformers"}), file=sys.stderr)
        sys.exit(1)

    try:
        # Load object detection pipeline with UI-DETR-1
        detector = pipeline("object-detection", model="racineai/UI-DETR-1")
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model: {str(e)}"}), file=sys.stderr)
        sys.exit(1)

    try:
        image = Image.open(args.image)
        
        # Run detection
        results = detector(image, threshold=args.threshold)
        
        output = []
        for result in results:
            box = result["box"]
            xmin, ymin, xmax, ymax = box["xmin"], box["ymin"], box["xmax"], box["ymax"]
            cx = int((xmin + xmax) / 2)
            cy = int((ymin + ymax) / 2)
            output.append({
                "label": result["label"],
                "score": round(result["score"], 4),
                "box": [xmin, ymin, xmax, ymax],
                "center": [cx, cy]
            })
            
        print(json.dumps({"success": True, "elements": output}))
    except Exception as e:
        print(json.dumps({"error": f"Inference failed: {str(e)}"}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
