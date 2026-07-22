import cv2
import numpy as np
import os
import csv
import json
import time
import threading
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import FastAPI, HTTPException, Response, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─────────────────────────────────────────
# PATHS & CONFIG
# ─────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CAMERAS_FILE = os.path.join(BASE_DIR, "cameras.json")
CSV_FILE = os.path.join(BASE_DIR, "aruco_tracker.csv")
TIMEOUT_SEC = 10  # Seconds before marking marker as OUT

# Ensure CSV exists
if not os.path.exists(CSV_FILE):
    with open(CSV_FILE, "w", newline="") as f:
        csv.writer(f).writerow(["CAMERA_NAME", "CAMERA_IP", "ID", "IN_TIME", "OUT_TIME"])

# ─────────────────────────────────────────
# OPTIMIZED MULTI-TAG ARUCO DETECTOR SETUP
# ─────────────────────────────────────────
aruco = cv2.aruco

# High-sensitivity detector parameters for multi-tag parallel detection
detector_params = aruco.DetectorParameters()
detector_params.cornerRefinementMethod = aruco.CORNER_REFINE_SUBPIX
detector_params.minMarkerDistanceRate = 0.01  # Allows detecting tags placed close to each other
detector_params.adaptiveThreshWinSizeMin = 3
detector_params.adaptiveThreshWinSizeMax = 23
detector_params.adaptiveThreshWinSizeStep = 3

# Predefine detectors for 4x4, 5x5, and 6x6 ArUco dictionaries
DICTIONARIES = [
    ("4X4", aruco.getPredefinedDictionary(aruco.DICT_4X4_250)),
    ("5X5", aruco.getPredefinedDictionary(aruco.DICT_5X5_250)),
    ("6X6", aruco.getPredefinedDictionary(aruco.DICT_6X6_250)),
]

detectors = [(name, aruco.ArucoDetector(d, detector_params)) for name, d in DICTIONARIES]

# ─────────────────────────────────────────
# CAMERA WORKER THREAD & MANAGER
# ─────────────────────────────────────────
class CameraWorker:
    def __init__(self, cam_id: str, name: str, ip: str, enabled: bool = True):
        self.cam_id = cam_id
        self.name = name
        self.ip = ip
        self.enabled = enabled
        
        self.running = True
        self.online = False
        self.frame: Optional[np.ndarray] = None
        self.lock = threading.Lock()
        
        self.active_ids: Dict[str, str] = {}    # marker_id -> in_time_str
        self.last_seen: Dict[str, datetime] = {} # marker_id -> datetime
        
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def update_config(self, name: str, ip: str, enabled: bool):
        with self.lock:
            self.name = name
            self.ip = ip
            self.enabled = enabled

    def stop(self):
        self.running = False

    def _capture_loop(self):
        import urllib.request

        while self.running:
            if not self.enabled:
                self.online = False
                time.sleep(1)
                continue

            # Build stream and capture fallback URLs
            clean_ip = self.ip.replace("http://", "").replace("https://", "").strip("/")
            stream_url = f"http://{clean_ip}:81/stream" if ":" not in clean_ip else f"http://{clean_ip}/stream"
            capture_url = f"http://{clean_ip}/capture"

            stream_success = False

            # Method 1: Try MJPEG stream first
            try:
                req = urllib.request.Request(stream_url, headers={'User-Agent': 'Mozilla/5.0'})
                stream = urllib.request.urlopen(req, timeout=3)
                bytes_data = b''
                
                while self.running and self.enabled:
                    bytes_data += stream.read(4096)
                    a = bytes_data.find(b'\xff\xd8') # JPEG Start of Image
                    if a != -1:
                        bytes_data = bytes_data[a:]
                        b = bytes_data.find(b'\xff\xd9') # JPEG End of Image
                        if b != -1:
                            jpg = bytes_data[:b+2]
                            bytes_data = bytes_data[b+2:]
                            
                            img_np = np.frombuffer(jpg, dtype=np.uint8)
                            frame = cv2.imdecode(img_np, cv2.IMREAD_COLOR)

                            if frame is not None:
                                self.online = True
                                stream_success = True
                                self._process_frame(frame)
            except Exception:
                pass

            # Method 2: Fallback to /capture snapshot polling if /stream isn't available
            if not stream_success and self.running and self.enabled:
                try:
                    req = urllib.request.Request(capture_url, headers={'User-Agent': 'Mozilla/5.0'})
                    img_resp = urllib.request.urlopen(req, timeout=3)
                    raw = img_resp.read()
                    img_np = np.frombuffer(raw, dtype=np.uint8)
                    frame = cv2.imdecode(img_np, cv2.IMREAD_COLOR)

                    if frame is not None:
                        self.online = True
                        self._process_frame(frame)
                        time.sleep(0.12) # ~8 FPS snapshot polling delay
                        continue
                except Exception:
                    pass

            self.online = False
            time.sleep(1) # Retry connection delay if network drops

    def _process_frame(self, frame: np.ndarray):
        try:
            current_time = datetime.now()
            time_str = current_time.strftime("%H:%M:%S")

            # ── 1. Convert Frame to Grayscale ─────────────────────────────
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            
            # ── 2. Convert Grayscale back to 3-Channel BGR for crisp overlays ──
            processed_frame = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

            # ── 3. ArUco Marker Detection (Multi-Tag Parallel) ───────────
            detected_now = set()

            for dict_name, det in detectors:
                res = det.detectMarkers(gray)
                corners, ids = res[0], res[1]

                if ids is not None and len(ids) > 0:
                    flat_ids = np.array(ids).flatten()
                    for i, mid_val in enumerate(flat_ids):
                        marker_id = str(int(mid_val)) if dict_name == "4X4" else f"{dict_name}_{int(mid_val)}"
                        if marker_id in detected_now:
                            continue
                        detected_now.add(marker_id)

                        # IN Event Log
                        if marker_id not in self.active_ids:
                            self.active_ids[marker_id] = time_str
                            print(f"[{self.name}] [IN ] ID={marker_id} at {time_str}")

                        self.last_seen[marker_id] = current_time

                        # Draw High-Contrast Bright Green Bounding Boxes & ID Text
                        pts = np.int32(corners[i]).reshape(-1, 2)
                        cv2.polylines(processed_frame, [pts], True, (0, 255, 0), 2)
                        text_org = (int(pts[0][0]), int(pts[0][1]))
                        cv2.putText(processed_frame, f"ID:{marker_id}", text_org,
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

            # ── 4. Process OUT Events ─────────────────────────────────────
            to_remove = []
            for mid, in_time in list(self.active_ids.items()):
                if mid in self.last_seen:
                    elapsed = (current_time - self.last_seen[mid]).total_seconds()
                    if elapsed > TIMEOUT_SEC and mid not in detected_now:
                        out_time = time_str
                        print(f"[{self.name}] [OUT] ID={mid} at {out_time}")

                        try:
                            with open(CSV_FILE, "a", newline="") as f:
                                csv.writer(f).writerow([self.name, self.ip, mid, in_time, out_time])
                        except Exception as e:
                            print(f"CSV write error: {e}")

                        to_remove.append(mid)

            for mid in to_remove:
                self.active_ids.pop(mid, None)
                self.last_seen.pop(mid, None)

            # Draw Camera Name Overlay
            cv2.putText(processed_frame, f"{self.name} ({self.ip}) - GRAYSCALE",
                        (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)

            with self.lock:
                self.frame = processed_frame
        except Exception as e:
            print(f"[{self.name}] Exception in _process_frame: {e}")

    def get_jpeg_frame(self) -> bytes:
        with self.lock:
            if self.frame is not None and self.online and self.enabled:
                _, jpeg = cv2.imencode('.jpg', self.frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                return jpeg.tobytes()
        
        # Return offline placeholder image
        blank = np.zeros((240, 320, 3), dtype=np.uint8)
        text = f"{self.name} (OFFLINE)" if self.enabled else f"{self.name} (DISABLED)"
        cv2.putText(blank, text, (20, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
        _, jpeg = cv2.imencode('.jpg', blank)
        return jpeg.tobytes()

class CameraManager:
    def __init__(self):
        self.workers: Dict[str, CameraWorker] = {}
        self.load_cameras()

    def load_cameras(self):
        if not os.path.exists(CAMERAS_FILE):
            default_config = [
                {"id": "cam_1", "name": "Main Gate", "ip": "10.22.18.80", "enabled": True}
            ]
            with open(CAMERAS_FILE, "w") as f:
                json.dump(default_config, f, indent=2)

        try:
            with open(CAMERAS_FILE, "r") as f:
                data = json.load(f)
                for cam in data:
                    cam_id = cam.get("id")
                    if cam_id not in self.workers:
                        self.workers[cam_id] = CameraWorker(
                            cam_id=cam_id,
                            name=cam.get("name", f"Cam {cam_id}"),
                            ip=cam.get("ip", "127.0.0.1"),
                            enabled=cam.get("enabled", True)
                        )
                    else:
                        self.workers[cam_id].update_config(
                            name=cam.get("name"),
                            ip=cam.get("ip"),
                            enabled=cam.get("enabled")
                        )
        except Exception as e:
            print(f"Error loading cameras.json: {e}")

    def save_cameras(self):
        data = []
        for worker in self.workers.values():
            data.append({
                "id": worker.cam_id,
                "name": worker.name,
                "ip": worker.ip,
                "enabled": worker.enabled
            })
        with open(CAMERAS_FILE, "w") as f:
            json.dump(data, f, indent=2)

    def add_or_update(self, cam_id: str, name: str, ip: str, enabled: bool):
        if cam_id in self.workers:
            self.workers[cam_id].update_config(name, ip, enabled)
        else:
            self.workers[cam_id] = CameraWorker(cam_id, name, ip, enabled)
        self.save_cameras()

    def delete_camera(self, cam_id: str):
        if cam_id in self.workers:
            self.workers[cam_id].stop()
            del self.workers[cam_id]
            self.save_cameras()

manager = CameraManager()

# ─────────────────────────────────────────
# FASTAPI APP & REST ENDPOINTS
# ─────────────────────────────────────────
app = FastAPI(title="Multi-Camera ArUco Tracking System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class CameraSchema(BaseModel):
    id: Optional[str] = None
    name: str
    ip: str
    enabled: bool = True

@app.get("/api/cameras")
def get_cameras():
    result = []
    for w in manager.workers.values():
        result.append({
            "id": w.cam_id,
            "name": w.name,
            "ip": w.ip,
            "enabled": w.enabled,
            "online": w.online,
            "active_tags": list(w.active_ids.keys())
        })
    return result

@app.post("/api/cameras")
def save_camera(cam: CameraSchema):
    try:
        cam_id = cam.id if (cam.id and cam.id.strip()) else f"cam_{int(time.time())}"
        manager.add_or_update(cam_id, cam.name, cam.ip, cam.enabled)
        return {"status": "success", "id": cam_id}
    except Exception as e:
        print(f"Error in save_camera: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/cameras/{cam_id}")
def delete_camera(cam_id: str):
    manager.delete_camera(cam_id)
    return {"status": "success"}

def generate_mjpeg_stream(cam_id: str):
    while True:
        if cam_id in manager.workers:
            frame_bytes = manager.workers[cam_id].get_jpeg_frame()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        time.sleep(0.04) # ~25 FPS stream speed

@app.get("/api/stream/{cam_id}")
def video_stream(cam_id: str):
    if cam_id not in manager.workers:
        raise HTTPException(status_code=404, detail="Camera not found")
    return StreamingResponse(
        generate_mjpeg_stream(cam_id),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/logs")
def get_logs():
    logs = []
    if os.path.exists(CSV_FILE):
        try:
            with open(CSV_FILE, "r") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    logs.append(row)
        except Exception as e:
            print(f"Error reading CSV: {e}")
    # Return reverse chronological order (newest first)
    return logs[::-1]

@app.delete("/api/logs")
def clear_logs():
    try:
        with open(CSV_FILE, "w", newline="") as f:
            csv.writer(f).writerow(["CAMERA_NAME", "CAMERA_IP", "ID", "IN_TIME", "OUT_TIME"])
        return {"status": "success", "message": "Logs cleared successfully"}
    except Exception as e:
        print(f"Error clearing CSV log: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/export-csv")
def export_csv():
    if os.path.exists(CSV_FILE):
        return FileResponse(CSV_FILE, filename="aruco_tracker.csv", media_type="text/csv")
    raise HTTPException(status_code=404, detail="CSV file not found")

# Serve UI files
@app.get("/")
def serve_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

@app.get("/{filename}")
def serve_static(filename: str):
    file_path = os.path.join(BASE_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")

if __name__ == "__main__":
    import uvicorn
    print("Starting Multi-Camera Tracking Server on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
