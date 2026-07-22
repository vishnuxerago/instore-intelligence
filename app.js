/* ==========================================
   Multi-Camera ArUco Vision System Logic
   ========================================== */

function getApiBase() {
  const saved = localStorage.getItem("backend_url");
  if (saved && saved.trim()) {
    return saved.trim().replace(/\/$/, "");
  }
  if (window.location.port === "5500" || window.location.port === "5501" || window.location.protocol === "file:") {
    return "http://localhost:8000";
  }
  if (window.location.hostname.includes("vercel.app") || window.location.hostname.includes("github.io")) {
    return "http://10.22.18.166:8000"; // Fallback to current PC IP
  }
  return "";
}

let API_BASE = getApiBase();

let camerasList = [];
let allLogs = [];

document.addEventListener("DOMContentLoaded", () => {
  loadCameras();
  loadLogs();
  setInterval(loadLogs, 1000);  // Poll logs every 1 second for live updates
  setInterval(loadCameras, 5000); // Refresh camera status every 5 seconds
});

// ─────────────────────────────────────────
// FETCH & RENDER CAMERAS
// ─────────────────────────────────────────
async function loadCameras() {
  try {
    const res = await fetch(`${API_BASE}/api/cameras`);
    if (!res.ok) return;
    camerasList = await res.json();
    renderCameras();
    updateMetrics();
  } catch (err) {
    console.error("Error loading cameras:", err);
  }
}

function renderCameras() {
  const grid = document.getElementById("cameraGrid");
  if (!grid) return;

  if (camerasList.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);">
        <i class="fa-solid fa-video-slash" style="font-size: 3rem; margin-bottom: 1rem; color: var(--accent-primary);"></i>
        <h3>No Cameras Configured</h3>
        <p>Click "Add Camera Host" above to add your ESP32 IP address.</p>
      </div>
    `;
    return;
  }

  // Remove empty state if present
  const emptyState = grid.querySelector('.empty-state');
  if (emptyState) grid.innerHTML = '';

  const activeCamIds = new Set(camerasList.map(c => c.id));

  // Remove cards that are no longer in camerasList
  Array.from(grid.children).forEach(child => {
    const camId = child.getAttribute('data-cam-id');
    if (camId && !activeCamIds.has(camId)) {
      child.remove();
    }
  });

  // Render or update each camera card
  camerasList.forEach(cam => {
    let card = document.getElementById(`cam-card-${cam.id}`);
    const activeTagsHtml = (cam.active_tags && cam.active_tags.length > 0)
      ? cam.active_tags.map(t => `<span class="tag-badge-sm">ID: ${escapeHtml(t)}</span>`).join(" ")
      : `<span style="color: var(--text-muted); font-size: 0.85rem;">None</span>`;

    if (!card) {
      // Create new camera card element
      card = document.createElement("div");
      card.className = "camera-card";
      card.id = `cam-card-${cam.id}`;
      card.setAttribute("data-cam-id", cam.id);
      
      card.innerHTML = `
        <div class="camera-card-header">
          <div>
            <div class="camera-title" id="cam-name-${cam.id}">${escapeHtml(cam.name)}</div>
            <div class="camera-ip" id="cam-ip-${cam.id}"><i class="fa-solid fa-network-wired"></i> ${escapeHtml(cam.ip)}</div>
          </div>
          <div class="status-indicator ${cam.online ? 'online' : 'offline'}" id="cam-status-${cam.id}" style="${!cam.online ? 'background: rgba(239, 68, 68, 0.1); color: var(--accent-danger); border-color: rgba(239, 68, 68, 0.3);' : ''}">
            <span class="status-dot" style="${!cam.online ? 'background: var(--accent-danger); box-shadow: none;' : ''}"></span>
            <span id="cam-status-text-${cam.id}">${cam.online ? 'LIVE' : 'OFFLINE'}</span>
          </div>
        </div>

        <div class="video-container">
          <img class="video-stream" id="cam-img-${cam.id}" src="${API_BASE}/api/stream/${cam.id}" alt="${escapeHtml(cam.name)}" onerror="handleStreamError('${cam.id}')">
          <div class="video-overlay-controls">
            <button class="btn-icon" onclick="reloadStream('${cam.id}')" title="Reload Stream Feed"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="btn-icon" onclick="openDirectStream('${cam.ip}')" title="Open Direct ESP32 Stream"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
          </div>
        </div>

        <div class="camera-card-footer">
          <div class="active-tags-container">
            <span style="color: var(--text-muted); font-size: 0.85rem; margin-right: 0.3rem;">Tags:</span>
            <span id="cam-tags-${cam.id}">${activeTagsHtml}</span>
          </div>
          <div style="display: flex; gap: 0.4rem;">
            <button class="btn btn-sm btn-secondary" onclick="editCamera('${cam.id}')" title="Edit Camera IP/Name">
              <i class="fa-solid fa-gear"></i>
            </button>
            <button class="btn btn-sm btn-danger" onclick="deleteCamera('${cam.id}')" title="Remove Camera">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    } else {
      // Update existing card DOM without disturbing the <img> stream
      const nameEl = document.getElementById(`cam-name-${cam.id}`);
      if (nameEl && nameEl.innerText !== cam.name) nameEl.innerText = cam.name;

      const ipEl = document.getElementById(`cam-ip-${cam.id}`);
      if (ipEl) ipEl.innerHTML = `<i class="fa-solid fa-network-wired"></i> ${escapeHtml(cam.ip)}`;

      const statusEl = document.getElementById(`cam-status-${cam.id}`);
      const statusTextEl = document.getElementById(`cam-status-text-${cam.id}`);
      if (statusEl && statusTextEl) {
        statusEl.className = `status-indicator ${cam.online ? 'online' : 'offline'}`;
        statusEl.style.cssText = cam.online ? '' : 'background: rgba(239, 68, 68, 0.1); color: var(--accent-danger); border-color: rgba(239, 68, 68, 0.3);';
        statusTextEl.innerText = cam.online ? 'LIVE' : 'OFFLINE';
      }

      const tagsEl = document.getElementById(`cam-tags-${cam.id}`);
      if (tagsEl) tagsEl.innerHTML = activeTagsHtml;
    }
  });
}

function reloadStream(camId) {
  const img = document.getElementById(`cam-img-${camId}`);
  if (img) {
    const originalSrc = `${API_BASE}/api/stream/${camId}`;
    img.src = `${originalSrc}?t=${Date.now()}`;
  }
}

function openDirectStream(ip) {
  window.open(`http://${ip}:81/stream`, '_blank');
}

function handleStreamError(camId) {
  const img = document.getElementById(`cam-img-${camId}`);
  if (img) {
    img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="%230b0f19"/><text x="50%" y="50%" fill="%2394a3b8" font-family="sans-serif" text-anchor="middle">Stream Reconnecting...</text></svg>';
    setTimeout(() => reloadStream(camId), 3000);
  }
}

// ─────────────────────────────────────────
// FETCH & RENDER LOGS
// ─────────────────────────────────────────
async function loadLogs() {
  try {
    const res = await fetch(`${API_BASE}/api/logs`);
    if (!res.ok) return;
    allLogs = await res.json();
    renderLogs(allLogs);
    updateMetrics();
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

function renderLogs(logs) {
  const tbody = document.getElementById("logsTableBody");
  if (!tbody) return;

  const query = document.getElementById("logSearch") ? document.getElementById("logSearch").value.toLowerCase() : "";

  const filtered = logs.filter(log => {
    return (log.CAMERA_NAME || "").toLowerCase().includes(query) ||
           (log.ID || "").toLowerCase().includes(query) ||
           (log.CAMERA_IP || "").toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          No detection log events recorded yet.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((log, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(log.CAMERA_NAME || 'Unknown')}</strong></td>
      <td class="timestamp">${escapeHtml(log.CAMERA_IP || '-')}</td>
      <td><span class="tag-badge">ID: ${escapeHtml(log.ID || '-')}</span></td>
      <td class="timestamp"><i class="fa-solid fa-arrow-right-to-bracket" style="color: var(--accent-success);"></i> ${escapeHtml(log.IN_TIME || '-')}</td>
      <td class="timestamp"><i class="fa-solid fa-arrow-right-from-bracket" style="color: var(--accent-danger);"></i> ${escapeHtml(log.OUT_TIME || '-')}</td>
      <td>
        <span class="status-indicator" style="background: rgba(59, 130, 246, 0.1); color: var(--accent-primary); border-color: rgba(59, 130, 246, 0.3);">
          Recorded
        </span>
      </td>
    </tr>
  `).join("");
}

function filterLogs() {
  renderLogs(allLogs);
}

async function clearLogs() {
  if (!confirm("Are you sure you want to clear all recorded detection logs? This cannot be undone.")) return;

  try {
    const res = await fetch(`${API_BASE}/api/logs`, { method: "DELETE" });
    if (res.ok) {
      allLogs = [];
      renderLogs(allLogs);
      updateMetrics();
    } else {
      const errText = await res.text();
      alert("Failed to clear logs: " + errText);
    }
  } catch (err) {
    console.error("Error clearing logs:", err);
    alert("Network error while attempting to clear logs.");
  }
}

// ─────────────────────────────────────────
// METRICS UPDATER
// ─────────────────────────────────────────
function updateMetrics() {
  document.getElementById("metricTotalCams").innerText = camerasList.length;
  
  const onlineCount = camerasList.filter(c => c.online).length;
  document.getElementById("metricOnlineCams").innerText = onlineCount;

  let activeTagsSet = new Set();
  camerasList.forEach(c => {
    if (c.active_tags) {
      c.active_tags.forEach(t => activeTagsSet.add(t));
    }
  });
  document.getElementById("metricActiveTags").innerText = activeTagsSet.size;

  document.getElementById("metricTotalLogs").innerText = allLogs.length;
}

// ─────────────────────────────────────────
// CAMERA MODAL (ADD / EDIT / DELETE)
// ─────────────────────────────────────────
function openCameraModal(cam = null) {
  const modal = document.getElementById("cameraModal");
  const modalTitle = document.getElementById("modalTitle");
  
  if (cam) {
    modalTitle.innerHTML = `<i class="fa-solid fa-gear"></i> Edit Camera Host`;
    document.getElementById("camId").value = cam.id;
    document.getElementById("camName").value = cam.name;
    document.getElementById("camIp").value = cam.ip;
    document.getElementById("camEnabled").checked = cam.enabled;
  } else {
    modalTitle.innerHTML = `<i class="fa-solid fa-video-plus"></i> Add Camera Host`;
    document.getElementById("camId").value = "";
    document.getElementById("camName").value = "";
    document.getElementById("camIp").value = "";
    document.getElementById("camEnabled").checked = true;
  }
  
  modal.classList.add("active");
}

function closeCameraModal() {
  document.getElementById("cameraModal").classList.remove("active");
}

function editCamera(camId) {
  const cam = camerasList.find(c => c.id === camId);
  if (cam) openCameraModal(cam);
}

async function handleSaveCamera(e) {
  e.preventDefault();
  
  const id = document.getElementById("camId").value;
  const name = document.getElementById("camName").value.trim();
  const ip = document.getElementById("camIp").value.trim();
  const enabled = document.getElementById("camEnabled").checked;

  if (!name || !ip) {
    alert("Please enter both Camera Name and IP address.");
    return;
  }

  const payload = { name, ip, enabled };
  if (id && id.trim() !== "") {
    payload.id = id.trim();
  }

  try {
    const res = await fetch(`${API_BASE}/api/cameras`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      closeCameraModal();
      loadCameras();
    } else {
      const errText = await res.text();
      alert("Failed to save camera settings: " + errText);
    }
  } catch (err) {
    console.error("Save error:", err);
    if (window.location.protocol === "https:" && API_BASE.startsWith("http://")) {
      alert("Browser Security Notice (Mixed Content Block):\n\nYour phone browser blocked 'http://' connection from 'https://' Vercel.\n\nSolution 1 (Recommended):\nOpen http://10.22.18.166:8000 directly in your phone browser.\n\nSolution 2:\nUse an HTTPS server URL (e.g. ngrok: npx ngrok http 8000).");
    } else {
      alert("Network error connecting to backend server (" + API_BASE + "). Please verify python server.py is running.");
    }
  }
}

async function deleteCamera(camId) {
  if (!confirm("Are you sure you want to remove this camera?")) return;

  try {
    const res = await fetch(`${API_BASE}/api/cameras/${camId}`, { method: "DELETE" });
    if (res.ok) {
      loadCameras();
    }
  } catch (err) {
    console.error("Delete error:", err);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[m]));
}

// ─────────────────────────────────────────
// SERVER IP CONFIGURATION MODAL
// ─────────────────────────────────────────
function openServerModal() {
  document.getElementById("serverUrl").value = API_BASE || "http://10.22.18.166:8000";
  document.getElementById("serverModal").classList.add("active");
}

function closeServerModal() {
  document.getElementById("serverModal").classList.remove("active");
}

function handleSaveServer(e) {
  e.preventDefault();
  let url = document.getElementById("serverUrl").value.trim().replace(/\/$/, "");
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
    url = "http://" + url;
  }
  localStorage.setItem("backend_url", url);
  API_BASE = url;
  closeServerModal();
  loadCameras();
  loadLogs();
}

function handleExportCsv(e) {
  e.preventDefault();
  window.open(`${API_BASE}/api/export-csv`, "_blank");
}
