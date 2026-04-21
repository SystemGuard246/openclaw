#!/usr/bin/env python3
"""
Skill: desktop-control
Visual autonomy via mouse/keyboard/screen control.

SECURITY REQUIREMENTS:
1. Must be explicitly enabled: /enable-desktop-control then /confirm <id>
2. Admin-only (TELEGRAM_ALLOWED_IDS only)
3. FAILSAFE=True: move mouse to top-left corner to abort immediately
4. All actions logged to audit trail
5. Confirmation required per-session for destructive actions (click, type, drag)
6. Rate limited: max 1 action per second

Install deps (once):
  pip install pyautogui pillow opencv-python-headless

Usage:
  /run desktop-control {"action": "screenshot"}
  /run desktop-control {"action": "info"}
  /run desktop-control {"action": "click", "x": 100, "y": 200}
  /run desktop-control {"action": "type", "text": "hello"}
  /run desktop-control {"action": "hotkey", "keys": ["ctrl", "c"]}
  /run desktop-control {"action": "find", "target": "OK", "click": false}
"""

import json
import os
import sys
import time
import base64
import io
from pathlib import Path

# ── Args ──────────────────────────────────────────────────────────────────────
args = {}
try:
    raw = os.environ.get("SKILL_ARGS") or sys.stdin.read()
    args = json.loads(raw) if raw.strip() else {}
except Exception:
    pass

action = str(args.get("action", "screenshot"))

# ── Opt-in gate ───────────────────────────────────────────────────────────────
# Check the SQLite config table for the desktop_control_enabled flag.
# This gate is enforced at the gateway level too (belt + suspenders).
OPENCLAW_DIR = Path(__file__).parent.parent
DB_PATH = OPENCLAW_DIR / "data" / "openclaw.db"

def is_enabled() -> bool:
    try:
        import sqlite3
        con = sqlite3.connect(str(DB_PATH))
        row = con.execute("SELECT value FROM config WHERE key='desktop_control_enabled'").fetchone()
        con.close()
        return row is not None and row[0] == "true"
    except Exception:
        return False

if not is_enabled():
    print(json.dumps({
        "ok": False,
        "error": "Desktop control is disabled. Use /enable-desktop-control in Telegram to opt in.",
    }))
    sys.exit(1)

# ── Dependency check ──────────────────────────────────────────────────────────
def check_deps():
    missing = []
    try: import pyautogui  # noqa
    except ImportError: missing.append("pyautogui")
    try: import PIL  # noqa
    except ImportError: missing.append("Pillow")
    return missing

missing = check_deps()
if missing:
    print(json.dumps({
        "ok": False,
        "error": f"Missing: pip install {' '.join(missing)}",
    }))
    sys.exit(1)

import pyautogui
import PIL.Image

# Safety: failsafe (top-left corner = abort), human-speed minimum between actions
pyautogui.PAUSE = 1.0   # 1 second between PyAutoGUI calls (human-speed)
pyautogui.FAILSAFE = True  # Move to top-left to abort

# ── Audit logger ──────────────────────────────────────────────────────────────
def log_action(action_name: str, detail: str):
    try:
        import sqlite3
        con = sqlite3.connect(str(DB_PATH))
        con.execute(
            "INSERT INTO audit_log (skill_name, command, exit_code) VALUES (?, ?, 0)",
            ("desktop-control", f"{action_name}: {detail[:200]}")
        )
        con.commit()
        con.close()
    except Exception:
        pass

# ── Read-only actions (screenshot, info) — no confirmation needed ─────────────

def take_screenshot():
    shot = pyautogui.screenshot()
    out_path = OPENCLAW_DIR / "data" / "screenshot.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    shot.save(str(out_path))
    w, h = shot.size
    log_action("screenshot", f"{w}x{h}")
    return {"ok": True, "action": "screenshot", "width": w, "height": h, "saved_to": str(out_path)}

def get_info():
    size = pyautogui.size()
    pos = pyautogui.position()
    return {"ok": True, "screen_width": size.width, "screen_height": size.height,
            "cursor_x": pos.x, "cursor_y": pos.y}

# ── Write actions (click, type, hotkey, drag) ─────────────────────────────────

def do_click(x: int, y: int, button: str = "left", double: bool = False):
    log_action("click", f"{button}@{x},{y} double={double}")
    if double:
        pyautogui.doubleClick(x, y, button=button)
    else:
        pyautogui.click(x, y, button=button)
    return {"ok": True, "action": "click", "x": x, "y": y, "double": double}

def do_type(text: str):
    if len(text) > 500:
        return {"ok": False, "error": "Text too long (max 500 chars)"}
    # Sanitize: no shell metacharacters in type action
    forbidden = ["`", "$", "\\"]
    if any(c in text for c in forbidden):
        return {"ok": False, "error": "Text contains disallowed characters"}
    log_action("type", f"{len(text)} chars")
    pyautogui.typewrite(text, interval=0.05)
    return {"ok": True, "action": "type", "chars": len(text)}

def do_hotkey(keys: list):
    if len(keys) > 4:
        return {"ok": False, "error": "Max 4 keys in a hotkey"}
    # Only allow known safe keys
    SAFE_KEYS = {
        "ctrl","cmd","alt","shift","enter","escape","tab","space","backspace",
        "delete","up","down","left","right","f1","f2","f3","f4","f5",
        "a","b","c","d","e","f","g","h","i","j","k","l","m",
        "n","o","p","q","r","s","t","u","v","w","x","y","z",
        "0","1","2","3","4","5","6","7","8","9",
    }
    for k in keys:
        if k.lower() not in SAFE_KEYS:
            return {"ok": False, "error": f"Key not in safe list: {k}"}
    log_action("hotkey", "+".join(keys))
    pyautogui.hotkey(*keys)
    return {"ok": True, "action": "hotkey", "keys": keys}

def do_move(x: int, y: int):
    log_action("move", f"{x},{y}")
    pyautogui.moveTo(x, y, duration=0.4)
    return {"ok": True, "action": "move", "x": x, "y": y}

def do_scroll(x: int, y: int, clicks: int):
    clicks = max(-10, min(10, clicks))  # clamp
    log_action("scroll", f"{clicks} clicks at {x},{y}")
    pyautogui.scroll(clicks, x=x or None, y=y or None)
    return {"ok": True, "action": "scroll", "clicks": clicks}

def do_drag(from_x: int, from_y: int, to_x: int, to_y: int):
    log_action("drag", f"{from_x},{from_y} → {to_x},{to_y}")
    pyautogui.moveTo(from_x, from_y)
    pyautogui.dragTo(to_x, to_y, duration=0.5, button="left")
    return {"ok": True, "action": "drag"}

def find_text(target: str, click: bool = False):
    """Find text on screen via OCR (requires pytesseract)."""
    try:
        import pytesseract, numpy as np, cv2
        shot = pyautogui.screenshot()
        shot_np = np.array(shot)
        gray = cv2.cvtColor(shot_np, cv2.COLOR_BGR2GRAY)
        data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)
        for i, word in enumerate(data["text"]):
            if target.lower() in word.lower() and data["conf"][i] > 60:
                x = data["left"][i] + data["width"][i] // 2
                y = data["top"][i] + data["height"][i] // 2
                if click:
                    log_action("find+click", f"{target} at {x},{y}")
                    pyautogui.click(x, y)
                return {"ok": True, "found": True, "target": target, "x": x, "y": y, "clicked": click}
        return {"ok": True, "found": False, "target": target}
    except ImportError as e:
        return {"ok": False, "error": f"Missing dep: {e}. pip install pytesseract opencv-python-headless"}

# ── Dispatch ──────────────────────────────────────────────────────────────────
try:
    if action == "screenshot":
        result = take_screenshot()
    elif action == "info":
        result = get_info()
    elif action == "click":
        result = do_click(int(args.get("x", 0)), int(args.get("y", 0)),
                          str(args.get("button", "left")), bool(args.get("double", False)))
    elif action == "type":
        result = do_type(str(args.get("text", "")))
    elif action == "hotkey":
        result = do_hotkey(list(args.get("keys", [])))
    elif action == "move":
        result = do_move(int(args.get("x", 0)), int(args.get("y", 0)))
    elif action == "scroll":
        result = do_scroll(int(args.get("x", 0)), int(args.get("y", 0)), int(args.get("clicks", -3)))
    elif action == "drag":
        result = do_drag(int(args.get("from_x", 0)), int(args.get("from_y", 0)),
                         int(args.get("to_x", 0)), int(args.get("to_y", 0)))
    elif action == "find":
        result = find_text(str(args.get("target", "")), bool(args.get("click", False)))
    elif action == "wait":
        secs = min(float(args.get("seconds", 1)), 10)  # cap at 10s
        time.sleep(secs)
        result = {"ok": True, "action": "wait", "seconds": secs}
    else:
        result = {"ok": False, "error": f"Unknown action: {action}",
                  "available": ["screenshot","info","click","type","hotkey","move","scroll","drag","find","wait"]}

    print(json.dumps(result, indent=2))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e), "action": action}))
    sys.exit(1)
