"""
vision_node_heartbeat.py
--------------------------
Run this ALONGSIDE your FastAPI vision service (main.py) on your laptop.
It periodically tells the Render middleware "I'm online, here's my current
ngrok URL" so the middleware knows whether to forward image-analysis
requests to you or respond with "image processing not available."

Usage:
    1. Start ngrok pointing at your FastAPI service:
         ngrok http 8000
       Copy the https://xxxx.ngrok-free.app URL it gives you.

    2. Set these env vars (or hardcode them below for local testing):
         MIDDLEWARE_URL=https://your-render-app.onrender.com
         NGROK_URL=https://xxxx.ngrok-free.app
         VISION_NODE_SECRET=<same secret as in the middleware's .env>

    3. Run:
         python vision_node_heartbeat.py

Keep this running the whole time you want the image pipeline available.
Stop it (Ctrl+C) or close your laptop, and after ~2 minutes the
middleware will consider the vision node offline and start responding
with "image processing not available" instead of forwarding requests
that would just time out.
"""

import os
import time
import requests

MIDDLEWARE_URL = os.getenv("MIDDLEWARE_URL", "http://localhost:3000")
NGROK_URL = os.getenv("NGROK_URL")  # e.g. https://xxxx.ngrok-free.app
VISION_NODE_SECRET = os.getenv("VISION_NODE_SECRET")

# Should be comfortably shorter than the middleware's STALE_THRESHOLD_MS
# (2 minutes) so a single missed heartbeat doesn't flip you offline.
HEARTBEAT_INTERVAL_SECONDS = 45


def register_once() -> bool:
    if not NGROK_URL:
        print("[heartbeat] NGROK_URL is not set — cannot register. Set it and retry.")
        return False
    if not VISION_NODE_SECRET:
        print("[heartbeat] VISION_NODE_SECRET is not set — cannot register. Set it and retry.")
        return False

    try:
        resp = requests.post(
            f"{MIDDLEWARE_URL}/vision-node/register",
            json={"url": NGROK_URL, "secret": VISION_NODE_SECRET},
            timeout=10,
        )
        resp.raise_for_status()
        print(f"[heartbeat] Registered OK: {resp.json()}")
        return True
    except requests.RequestException as e:
        print(f"[heartbeat] Registration failed: {e}")
        return False


def main():
    print(f"[heartbeat] Registering with middleware at {MIDDLEWARE_URL}")
    print(f"[heartbeat] Advertising vision node URL: {NGROK_URL}")
    print(f"[heartbeat] Sending a heartbeat every {HEARTBEAT_INTERVAL_SECONDS}s. Ctrl+C to stop.")

    while True:
        register_once()
        time.sleep(HEARTBEAT_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
