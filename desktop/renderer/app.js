const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
  iceCandidatePoolSize: 2,
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const API = (params.get("apiUrl") || "http://127.0.0.1:3780").replace(/\s+/g, "").replace(/\/$/, "");
const SIGNAL = API.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const state = {
  token: localStorage.getItem("desklyToken") || "",
  role: params.get("role") || "",
  me: null,
  settings: {
    mouseFollow: true,
    blockWinKey: true,
    videoQuality: "balanced",
    screenSize: "adaptive",
    hostRunInBackground: false,
    recentDevices: [],
  },
  ws: null,
  wsReconnectTimer: null,
  wsReconnectDelay: 1000,
  wsInSession: false,
  pc: null,
  dc: null,
  cursorDc: null,
  hostVideoTrack: null,
  iceQueue: [],
  iceRestartTimer: null,
  inputArmed: true,
  cmd: "",
  connecting: false,
  hostAccessPassword: "",
  showAccessPassword: false,
  remoteInputPaused: false,
  savedAccess: [],
  screenFit: localStorage.getItem("desklyScreenFit") || "adaptive",
  lastRemoteInputAt: 0,
  suppressSendMouseMoveUntil: 0,
  hostCursor: null,
  ctrlCursor: null,
};

function log(level, category, message, data) {
  const consoleFn = console[level] || console.log;
  if (data !== undefined) {
    consoleFn(`[${category}] ${message}`, data);
  } else {
    consoleFn(`[${category}] ${message}`);
  }
  if (window.deskly?.log) {
    window.deskly.log(level, category, message, data).catch(() => {});
  }
}

function show(id) {
  for (const el of document.querySelectorAll("section")) el.classList.add("hidden");
  $(id).classList.remove("hidden");
  const inSession = id === "view-session";
  $("session-controls")?.classList.toggle("hidden", !inSession);
  $("btn-hangup")?.classList.toggle("hidden", !inSession);
  $("btn-logout")?.classList.toggle(
    "hidden",
    inSession || id === "view-login" || id === "view-register" || id === "view-setup"
  );
}

function setStatus(text) {
  $("status-pill").textContent = text;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (netErr) {
    const err = new Error(`Cannot reach API at ${API} (${netErr.message})`);
    err.isNetworkError = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function qualityConstraints(overrideSize) {
  const size = overrideSize || state.settings.screenSize || "adaptive";
  const frameRate = { ideal: 60, max: 60 };
  if (size === "720p") {
    return { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate };
  }
  if (size === "1080p") {
    return { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate };
  }
  return { width: { ideal: 1920, max: 3840 }, height: { ideal: 1080, max: 2160 }, frameRate };
}

function displayId(id) {
  return String(id).replace(/\D/g, "").replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}

function renderHostAccessPassword() {
  const passEl = $("host-pass");
  if (!passEl) return;
  if (!state.hostAccessPassword) {
    passEl.textContent = "••••••••";
    $("btn-toggle-pass").textContent = "Show";
    return;
  }
  if (state.showAccessPassword) {
    passEl.textContent = state.hostAccessPassword;
    $("btn-toggle-pass").textContent = "Hide";
  } else {
    passEl.textContent = "••••••••";
    $("btn-toggle-pass").textContent = "Show";
  }
}

function paintHome() {
  show("view-home");
  const host = state.me?.devices?.host;
  $("host-id").textContent = host?.publicIdDisplay || host?.publicId || "—";
  if (host?.accessPassword) {
    state.hostAccessPassword = host.accessPassword;
  }
  renderHostAccessPassword();

  if (state.me?.user?.username) {
    $("user-badge").textContent = `@${state.me.user.username}`;
    $("user-badge").classList.remove("hidden");
    $("profile-username").value = state.me.user.username;
  }

  applyRoleUi();
  $("set-follow").checked = !!state.settings.mouseFollow;
  $("set-winkey").checked = state.settings.blockWinKey !== false;
  $("set-quality").value = state.settings.videoQuality || "balanced";
  $("set-screen-size").value = state.settings.screenSize || "adaptive";
  $("set-background").checked = !!state.settings.hostRunInBackground;
  renderRecentDevices();
}

function renderRecentDevices() {
  const dbDevices = state.settings.recentDevices || [];
  const localDevices = state.savedAccess || [];
  const deviceMap = new Map();

  for (const item of localDevices) {
    const id = String(item.publicId || "").replace(/\D/g, "");
    if (id) {
      deviceMap.set(id, {
        publicId: id,
        username: item.username || "Unknown device",
        password: item.password || "",
        online: false,
        lastConnectedAt: item.lastConnectedAt || null,
      });
    }
  }

  for (const item of dbDevices) {
    const id = String(item.publicId || "").replace(/\D/g, "");
    if (id) {
      const existing = deviceMap.get(id);
      deviceMap.set(id, {
        publicId: id,
        username: item.username || existing?.username || "Unknown device",
        password: item.accessPassword || existing?.password || "",
        online: !!item.online,
        lastConnectedAt: item.lastConnectedAt || existing?.lastConnectedAt,
      });
    }
  }

  const devices = Array.from(deviceMap.values()).sort(
    (a, b) => new Date(b.lastConnectedAt || 0) - new Date(a.lastConnectedAt || 0)
  );

  const container = $("recent-list");
  container.replaceChildren();
  $("saved-count").textContent = devices.length;
  $("recent-devices").classList.toggle("hidden", devices.length === 0);

  for (const device of devices) {
    const card = document.createElement("div");
    card.className = "recent-card";

    const left = document.createElement("div");
    left.className = "recent-card-left";

    const nameRow = document.createElement("div");
    nameRow.className = "recent-name-row";

    const dot = document.createElement("span");
    dot.className = "status-dot" + (device.online ? " online" : "");
    dot.title = device.online ? "Host is Online" : "Host is Offline";

    const name = document.createElement("span");
    name.className = "recent-username";
    name.textContent = device.username || "Unknown device";

    nameRow.append(dot, name);

    const id = document.createElement("span");
    id.className = "recent-id";
    id.textContent = displayId(device.publicId);

    left.append(nameRow, id);

    const right = document.createElement("div");
    right.className = "recent-card-right";

    const connectBtn = document.createElement("button");
    connectBtn.className = "btn-connect-card";
    connectBtn.textContent = "Connect";
    connectBtn.title = "Instant connect with saved credentials";
    connectBtn.onclick = async () => {
      $("connect-id").value = displayId(device.publicId);
      $("connect-pass").value = device.password;
      await connectToHost(device.publicId, device.password);
    };

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-card";
    removeBtn.textContent = "Remove";
    removeBtn.title = "Remove from saved list";
    removeBtn.onclick = async () => {
      await window.deskly.removeAccess(device.publicId);
      state.savedAccess = await window.deskly.accessList();
      try {
        const res = await api(`/api/settings/recent-devices/${device.publicId}`, { method: "DELETE" });
        if (res.settings) state.settings = res.settings;
      } catch {
        /* ignore */
      }
      renderRecentDevices();
    };

    right.append(connectBtn, removeBtn);
    card.append(left, right);
    container.append(card);
  }
}

function applyRoleUi() {
  $("btn-role-host").classList.toggle("active", state.role === "host");
  $("btn-role-controller").classList.toggle("active", state.role === "controller");
  $("host-info").classList.toggle("hidden", state.role !== "host");
  $("background-setting").classList.toggle("hidden", state.role !== "host");
  $("controller-box").classList.toggle("hidden", state.role !== "controller");
  if (state.role === "host") setStatus("Host — waiting (no accept prompt)");
  else if (state.role === "controller") setStatus("Controller — enter ID + password");
}

async function bootstrap() {
  log("info", "App", "Deskly starting up");
  const startRole = await window.deskly.getStartRole();
  if (startRole) state.role = startRole;
  if (window.deskly?.setActiveRole && state.role) await window.deskly.setActiveRole(state.role);
  if (!state.token) {
    show("view-login");
    setStatus("Log in or create account");
    await window.deskly.showWindow();
    return;
  }
  try {
    const me = await api("/api/me");
    state.me = me;
    state.settings = me.settings || state.settings;
    state.savedAccess = await window.deskly.accessList();
    paintHome();
    if (state.role) await openSocket();
    if (state.role === "host" && state.settings.hostRunInBackground) {
      await window.deskly.setBackground(true);
    }
  } catch (err) {
    if (err.status === 401) {
      log("warn", "App", "Token validation failed, directing to login", err.message);
      localStorage.removeItem("desklyToken");
      state.token = "";
      show("view-login");
      await window.deskly.showWindow();
    } else {
      log("warn", "App", `Cannot reach server at ${API}: ${err.message}. Retrying in 3s...`);
      setStatus(`API server offline (${API}). Retrying...`);
      setTimeout(() => bootstrap(), 3000);
    }
  }
}

function saveLogin(data) {
  state.token = data.token;
  localStorage.setItem("desklyToken", data.token);
  state.me = data;
  state.settings = data.settings || state.settings;
  state.hostAccessPassword = data.devices?.host?.accessPassword || "";
  log("info", "Auth", `Logged in as user ${data.user?.username || "unknown"}`);
}

$("btn-setup").onclick = async () => {
  $("setup-error").textContent = "";
  try {
    const data = await api("/api/setup", {
      method: "POST",
      body: { username: $("setup-user").value, password: $("setup-pass").value },
    });
    saveLogin(data);
    paintHome();
  } catch (e) {
    $("setup-error").textContent = e.message;
  }
};

$("btn-login").onclick = async () => {
  $("login-error").textContent = "";
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: { username: $("login-user").value, password: $("login-pass").value },
    });
    saveLogin(data);
    paintHome();
    if (state.role) await openSocket();
    if (state.role === "host" && state.settings.hostRunInBackground) {
      await window.deskly.setBackground(true);
    }
  } catch (e) {
    $("login-error").textContent = e.message;
  }
};

$("btn-role-host").onclick = () => setRole("host");
$("btn-role-controller").onclick = () => setRole("controller");

async function setRole(role) {
  log("info", "Role", `Switched role to ${role}`);
  state.role = role;
  if (window.deskly?.setActiveRole) await window.deskly.setActiveRole(role);
  applyRoleUi();
  await openSocket();
}

async function saveSettings() {
  state.settings = {
    mouseFollow: $("set-follow").checked,
    blockWinKey: $("set-winkey").checked,
    videoQuality: $("set-quality").value,
    screenSize: $("set-screen-size").value,
    hostRunInBackground: $("set-background").checked,
    recentDevices: state.settings.recentDevices || [],
  };
  log("info", "Settings", "Saving settings", state.settings);
  const res = await api("/api/settings", { method: "PATCH", body: state.settings });
  if (res.settings) state.settings = res.settings;
  $("save-msg").textContent = "Saved.";
  setTimeout(() => ($("save-msg").textContent = ""), 1500);
}

$("set-follow").onchange = () => setMouseFollow($("set-follow").checked);
$("set-winkey").onchange = saveSettings;
$("set-quality").onchange = saveSettings;
$("set-screen-size").onchange = () => {
  setScreenResolution($("set-screen-size").value);
  saveSettings();
};
$("set-background").onchange = async () => {
  await saveSettings();
  if (state.role === "host") await window.deskly.setBackground(state.settings.hostRunInBackground);
};

$("btn-copy-id").onclick = () => {
  const host = state.me?.devices?.host;
  const val = host?.publicIdDisplay || host?.publicId || "";
  if (!val) return;
  navigator.clipboard.writeText(val.replace(/\s/g, ""));
  const btn = $("btn-copy-id");
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = orig), 1500);
};

$("btn-copy-pass").onclick = () => {
  if (!state.hostAccessPassword) return;
  navigator.clipboard.writeText(state.hostAccessPassword);
  const btn = $("btn-copy-pass");
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = orig), 1500);
};

$("btn-toggle-pass").onclick = () => {
  state.showAccessPassword = !state.showAccessPassword;
  renderHostAccessPassword();
};

$("btn-save-access-pass").onclick = async () => {
  const inputEl = $("new-access-pass");
  const msgEl = $("host-pass-msg");
  const val = inputEl.value.trim();
  if (val.length < 4) {
    msgEl.className = "error";
    msgEl.textContent = "Access password must be at least 4 characters.";
    return;
  }
  try {
    const data = await api("/api/devices/host/change-access-password", {
      method: "POST",
      body: { accessPassword: val },
    });
    state.hostAccessPassword = data.device.accessPassword;
    state.showAccessPassword = true;
    renderHostAccessPassword();
    inputEl.value = "";
    msgEl.className = "ok";
    msgEl.textContent = "Access password updated successfully!";
    log("info", "Host", "Host access password updated");
    setTimeout(() => (msgEl.textContent = ""), 3000);
  } catch (e) {
    msgEl.className = "error";
    msgEl.textContent = `Error: ${e.message}`;
  }
};

$("btn-random-access-pass").onclick = async () => {
  const msgEl = $("host-pass-msg");
  try {
    const data = await api("/api/devices/host/change-access-password", {
      method: "POST",
      body: {},
    });
    state.hostAccessPassword = data.device.accessPassword;
    state.showAccessPassword = true;
    renderHostAccessPassword();
    msgEl.className = "ok";
    msgEl.textContent = "Generated new random access password!";
    log("info", "Host", "Generated random host access password");
    setTimeout(() => (msgEl.textContent = ""), 3000);
  } catch (e) {
    msgEl.className = "error";
    msgEl.textContent = `Error: ${e.message}`;
  }
};

$("connect-id").oninput = () => {
  const typed = $("connect-id").value.replace(/\D/g, "");
  if (typed.length >= 9) {
    const found =
      (state.savedAccess || []).find((d) => d.publicId === typed) ||
      (state.settings.recentDevices || []).find((d) => d.publicId === typed);
    if (found && (found.password || found.accessPassword)) {
      $("connect-pass").value = found.password || found.accessPassword;
    }
  }
};

$("btn-save-username").onclick = async () => {
  const msgEl = $("profile-username-msg");
  const newName = $("profile-username").value.trim().toLowerCase();
  if (newName.length < 3) {
    msgEl.className = "error";
    msgEl.textContent = "Username must be at least 3 characters.";
    return;
  }
  try {
    const res = await api("/api/account/username", {
      method: "PATCH",
      body: { username: newName },
    });
    if (state.me?.user) state.me.user.username = res.user.username;
    $("user-badge").textContent = `@${res.user.username}`;
    msgEl.className = "ok";
    msgEl.textContent = "Username updated in database!";
    log("info", "Account", `Username updated to ${res.user.username}`);
    setTimeout(() => (msgEl.textContent = ""), 3000);
  } catch (e) {
    msgEl.className = "error";
    msgEl.textContent = e.message;
  }
};

$("btn-show-register").onclick = () => {
  $("register-error").textContent = "";
  show("view-register");
  setStatus("Create account");
};

$("btn-show-login").onclick = () => {
  $("login-error").textContent = "";
  show("view-login");
  setStatus("Log in");
};

$("btn-register").onclick = async () => {
  $("register-error").textContent = "";
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: { username: $("register-user").value, password: $("register-pass").value },
    });
    saveLogin(data);
    paintHome();
    if (state.role) await openSocket();
  } catch (e) {
    $("register-error").textContent = e.message;
  }
};

async function logout() {
  log("info", "Auth", "Logging out");
  stopWsReconnect();
  cleanupPeer();
  try {
    if (state.ws) {
      state.ws._desklyManaged = true;
      state.ws.close();
    }
  } catch {
    /* ignore */
  }
  state.ws = null;
  state.wsInSession = false;
  state.token = "";
  state.me = null;
  state.hostAccessPassword = "";
  localStorage.removeItem("desklyToken");
  $("user-badge").classList.add("hidden");
  show("view-login");
  setStatus("Logged out");
  await window.deskly.setBackground(false);
}

$("btn-logout").onclick = logout;
$("btn-stop-host").onclick = logout;

$("btn-change-password").onclick = async () => {
  const message = $("change-password-msg");
  message.className = "error";
  message.textContent = "";
  try {
    await api("/api/account/change-password", {
      method: "POST",
      body: { currentPassword: $("change-current-pass").value, newPassword: $("change-new-pass").value },
    });
    $("change-current-pass").value = "";
    $("change-new-pass").value = "";
    message.className = "ok";
    message.textContent = "Account password changed.";
    log("info", "Auth", "Account password changed");
  } catch (e) {
    message.textContent = e.message;
  }
};

// ══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET — persistent with exponential back-off auto-reconnect
// ══════════════════════════════════════════════════════════════════════════════

function stopWsReconnect() {
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
}

function scheduleWsReconnect() {
  stopWsReconnect();
  if (!state.token || !state.role) return;
  const delay = state.wsReconnectDelay;
  // Exponential back-off: 1s → 2s → 4s → … → 30s max
  state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30000);
  log("info", "Signaling", `WS reconnect scheduled in ${delay}ms`);
  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = null;
    openSocket(true).catch(() => {});
  }, delay);
}

/**
 * Open (or reopen) the signaling WebSocket.
 * When isReconnect=true and a session is live, we silently re-attach
 * without ending the session.
 */
function openSocket(isReconnect = false) {
  return new Promise((resolve) => {
    if (state.ws) {
      try {
        state.ws._desklyManaged = true;
        state.ws.close();
      } catch {
        /* ignore */
      }
      state.ws = null;
    }

    const wsUrl = `${SIGNAL}/ws?token=${encodeURIComponent(state.token)}&role=${state.role}`;
    log("info", "Signaling", `Connecting WS (role=${state.role}${isReconnect ? ", reconnect" : ""})`);
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      state.wsReconnectDelay = 1000; // reset back-off on success
      log("info", "Signaling", `WebSocket connected as ${state.role}`);
      if (isReconnect && state.wsInSession) {
        setStatus(state.role === "host" ? "Host online" : "Connected (60 FPS)");
        setSessionFeedback("🔄 Signaling reconnected");
      } else {
        setStatus(state.role === "host" ? "Host online" : "Controller online");
      }
      resolve();
    };

    ws.onclose = (ev) => {
      if (ws._desklyManaged) return; // intentionally closed — skip
      log("warn", "Signaling", `WS closed (code=${ev.code})`);
      if (state.wsInSession) {
        // Session is live — keep it alive, reconnect silently
        setSessionFeedback("⚠️ Signaling dropped — reconnecting…");
      } else {
        setStatus("Signaling disconnected");
      }
      scheduleWsReconnect();
    };

    ws.onerror = (e) => {
      log("error", "Signaling", "WS error", e.message || "");
    };

    ws.onmessage = (ev) => onSignal(JSON.parse(ev.data));
  });
}

function sendWs(msg) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(msg));
  }
}

async function onSignal(msg) {
  if (msg.type === "start-session" && state.role === "host") {
    log("info", "Signaling", "Host received start-session command", msg.settings);
    state.settings = { ...state.settings, ...msg.settings };
    await startHostSession();
  }
  if (msg.type === "connect-result") {
    if (!msg.ok) {
      log("warn", "Signaling", `Connect failed: ${msg.error}`);
      $("connect-error").textContent = msg.error;
      cleanupPeer();
      state.wsInSession = false;
      paintHome();
      applyRoleUi();
    } else {
      log("info", "Signaling", "Connect result OK from host", msg.device);
      rememberConnectedDevice($("connect-id").value, $("connect-pass").value, msg.device?.username);
      const hostDisplay = msg.device?.username || displayId($("connect-id").value);
      $("session-label").textContent = `Host: ${hostDisplay}`;
      setStatus("Connecting…");
      setSessionFeedback("");
    }
  }
  if (msg.type === "signal") {
    await handleRtc(msg.data);
  }
  if (msg.type === "hangup") {
    // Explicit peer hangup — always end session
    log("info", "Signaling", "Peer sent explicit hangup — ending session");
    endSession("Peer disconnected");
  }
  if (msg.type === "peer-gone") {
    // Peer's WebSocket dropped — P2P may still be alive.
    // Wait for WebRTC to confirm before tearing down.
    log("warn", "Signaling", `Peer WS dropped (role=${msg.role}) — watching WebRTC state`);
    if (state.wsInSession) {
      setSessionFeedback("⚠️ Peer signal dropped — checking connection…");
      // Give WebRTC 15s to stay connected before ending
      scheduleIceRecoveryTimeout(15000);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ICE RECOVERY TIMEOUT
// ══════════════════════════════════════════════════════════════════════════════

function scheduleIceRecoveryTimeout(ms) {
  clearIceRecoveryTimer();
  state.iceRestartTimer = setTimeout(async () => {
    state.iceRestartTimer = null;
    const cs = state.pc?.connectionState;
    if (cs === "connected" || cs === "completed") {
      setSessionFeedback("✅ Connection stable");
      return;
    }
    // Try ICE restart from the offer side (host)
    if (state.role === "host" && state.pc && state.ws?.readyState === 1) {
      log("info", "WebRTC", "Attempting ICE restart");
      try {
        const offer = await state.pc.createOffer({ iceRestart: true });
        await state.pc.setLocalDescription(offer);
        sendWs({ type: "signal", data: { kind: "offer", sdp: offer } });
        setSessionFeedback("🔁 Reconnecting…");
        scheduleIceRecoveryTimeout(12000);
        return;
      } catch (err) {
        log("warn", "WebRTC", `ICE restart failed: ${err.message}`);
      }
    }
    // Give up — WebRTC is truly dead
    if (state.wsInSession) {
      log("info", "Session", "WebRTC did not recover — ending session");
      endSession("Connection lost");
    }
  }, ms);
}

function clearIceRecoveryTimer() {
  if (state.iceRestartTimer) {
    clearTimeout(state.iceRestartTimer);
    state.iceRestartTimer = null;
  }
}

async function rememberConnectedDevice(id, password, username) {
  const publicId = String(id || "").replace(/\D/g, "");
  if (!/^\d{9}$/.test(publicId) || !password) return;
  await window.deskly.saveAccess({ publicId, password, username: username || "Unknown device" });
  state.savedAccess = await window.deskly.accessList();

  const others = (state.settings.recentDevices || []).filter((item) => item.publicId !== publicId);
  state.settings.recentDevices = [
    { publicId, username: username || "Unknown device", accessPassword: password, lastConnectedAt: new Date().toISOString() },
    ...others,
  ].slice(0, 16);

  try {
    const res = await api("/api/settings", { method: "PATCH", body: { recentDevices: state.settings.recentDevices } });
    if (res.settings) state.settings = res.settings;
  } catch {
    /* ignore */
  }
  renderRecentDevices();
}

async function connectToHost(id, password) {
  $("connect-error").textContent = "";
  const hostId = String(id || "").replace(/\D/g, "");
  const pass = String(password || "");
  if (!hostId || !pass) {
    $("connect-error").textContent = "Please enter Host ID and access password.";
    return;
  }
  log("info", "Controller", `Initiating connection to Host ${hostId}`);
  if (state.role !== "controller") await setRole("controller");
  await prepareControllerPeer();
  sendWs({ type: "connect", hostId, password: pass });
}

$("btn-connect").onclick = () => connectToHost($("connect-id").value, $("connect-pass").value);

$("btn-hangup").onclick = () => {
  log("info", "Session", "User clicked hangup");
  sendWs({ type: "hangup" });
  endSession("Disconnected");
};

function bitrate() {
  const q = state.settings.videoQuality;
  if (q === "smooth") return 2_500_000;
  if (q === "sharp") return 7_500_000;
  return 4_500_000;
}

async function startHostSession() {
  const t0 = Date.now();
  log("info", "WebRTC", "Host preparing peer connection");
  cleanupPeer();
  const pc = new RTCPeerConnection(ICE);
  state.pc = pc;
  state.iceQueue = [];

  let hostDisconnectedTimer = null;
  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    log("info", "WebRTC", `Host connection state: ${cs}`);
    if (cs === "connected" || cs === "completed") {
      if (hostDisconnectedTimer) { clearTimeout(hostDisconnectedTimer); hostDisconnectedTimer = null; }
      clearIceRecoveryTimer();
      setStatus("Hosting (connected)");
    } else if (cs === "disconnected") {
      // Debounce transient ~5s STUN re-evaluation so UI doesn't flicker
      if (!hostDisconnectedTimer) {
        hostDisconnectedTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") {
            setStatus("Host — reconnecting…");
          }
        }, 2500);
      }
      scheduleIceRecoveryTimeout(12000);
    } else if (cs === "failed") {
      if (hostDisconnectedTimer) { clearTimeout(hostDisconnectedTimer); hostDisconnectedTimer = null; }
      if (state.wsInSession) scheduleIceRecoveryTimeout(0);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendWs({ type: "signal", data: { kind: "ice", candidate: e.candidate } });
  };

  const dc = pc.createDataChannel("deskly", { ordered: true });
  bindDataChannel(dc);
  const cursorDc = pc.createDataChannel("deskly-cursor", { ordered: false, maxRetransmits: 0 });
  bindCursorDataChannel(cursorDc);

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: qualityConstraints(),
      audio: false,
    });
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = "motion";
      state.hostVideoTrack = videoTrack;
      pc.addTrack(videoTrack, stream);
      log("info", "WebRTC", `Screen track acquired in ${Date.now() - t0}ms, contentHint=motion`);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: "signal", data: { kind: "offer", sdp: offer } });
    enterSession("Hosting — screen shared");
    window.deskly.startCursorLoop();
  } catch (err) {
    log("error", "WebRTC", `Failed to start host screen sharing: ${err.message}`);
    endSession("Screen share failed: " + err.message);
  }
}

async function prepareControllerPeer() {
  log("info", "WebRTC", "Controller preparing peer connection");
  cleanupPeer();
  const pc = new RTCPeerConnection(ICE);
  state.pc = pc;
  state.iceQueue = [];

  let ctrlDisconnectedTimer = null;
  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    log("info", "WebRTC", `Controller connection state: ${cs}`);
    if (cs === "connected" || cs === "completed") {
      if (ctrlDisconnectedTimer) { clearTimeout(ctrlDisconnectedTimer); ctrlDisconnectedTimer = null; }
      clearIceRecoveryTimer();
      setStatus("Connected (60 FPS)");
      setSessionFeedback("");
      const hostId = $("connect-id")?.value;
      if (hostId) $("session-label").textContent = `Host: ${displayId(hostId)}`;
      refreshWindowBounds();
    } else if (cs === "disconnected") {
      // Debounce transient STUN re-evaluation so UI doesn't flash needlessly
      if (!ctrlDisconnectedTimer) {
        ctrlDisconnectedTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") {
            setStatus("Reconnecting…");
            setSessionFeedback("⚠️ Reconnecting…");
          }
        }, 2500);
      }
      scheduleIceRecoveryTimeout(12000);
    } else if (cs === "failed") {
      if (ctrlDisconnectedTimer) { clearTimeout(ctrlDisconnectedTimer); ctrlDisconnectedTimer = null; }
      if (state.wsInSession) scheduleIceRecoveryTimeout(0);
    }
  };

  pc.ondatachannel = (e) => {
    if (e.channel.label === "deskly-cursor") {
      bindCursorDataChannel(e.channel);
    } else {
      bindDataChannel(e.channel);
    }
  };
  pc.ontrack = (e) => {
    log("info", "WebRTC", "Received remote video track");
    const videoEl = $("remote-video");
    videoEl.srcObject = e.streams[0];
    if (e.receiver && "playoutDelayHint" in e.receiver) {
      try {
        e.receiver.playoutDelayHint = 0;
        log("info", "WebRTC", "Enabled receiver.playoutDelayHint = 0 (zero jitter buffer delay)");
      } catch { /* ignore */ }
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sendWs({ type: "signal", data: { kind: "ice", candidate: e.candidate } });
  };
  enterSession("Connecting…");
}

async function drainIceQueue() {
  if (!state.pc || !state.pc.remoteDescription) return;
  while (state.iceQueue.length > 0) {
    const candidate = state.iceQueue.shift();
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (e) {
      log("warn", "WebRTC", `Error adding queued ICE candidate: ${e.message}`);
    }
  }
}

async function handleRtc(data) {
  if (!state.pc) return;
  if (data.kind === "offer") {
    const t0 = Date.now();
    log("info", "WebRTC", "Controller received offer, applying remote description");
    await state.pc.setRemoteDescription(data.sdp);
    await drainIceQueue();
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    sendWs({ type: "signal", data: { kind: "answer", sdp: answer } });
    log("info", "WebRTC", `Answer sent in ${Date.now() - t0}ms`);
  } else if (data.kind === "answer") {
    log("info", "WebRTC", "Host received answer, applying remote description");
    await state.pc.setRemoteDescription(data.sdp);
    await drainIceQueue();
  } else if (data.kind === "ice" && data.candidate) {
    if (state.pc.remoteDescription) {
      try {
        await state.pc.addIceCandidate(data.candidate);
      } catch (err) {
        log("warn", "WebRTC", `Could not add ICE candidate: ${err.message}`);
      }
    } else {
      state.iceQueue.push(data.candidate);
    }
  }
}

function bindDataChannel(dc) {
  state.dc = dc;
  dc.onopen = () => {
    log("info", "DataChannel", "WebRTC DataChannel opened");
    setStatus("P2P connected");
    applyBitrate();
    window.deskly.startCursorLoop();
    if (state.role === "controller") {
      // Only the Host may lock or unlock remote input.
      state.inputArmed = true;
      setSessionFeedback("Input ready — Host controls access.");
    } else if (state.role === "host") {
      window.deskly.cursor().then((norm) => {
        if (norm && Number.isFinite(norm.x) && Number.isFinite(norm.y)) {
          dcSend({ t: "host-cursor", x: norm.x, y: norm.y });
        }
      }).catch(() => {});
    }
  };
  dc.onmessage = (ev) => onControlMessage(JSON.parse(ev.data));
}

async function applyBitrate() {
  if (!state.pc) return;
  const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === "video");
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = bitrate();
  p.encodings[0].networkPriority = "high";
  try {
    await sender.setParameters({ ...p, degradationPreference: "maintain-framerate" });
    log("info", "WebRTC", `Applied bitrate: ${p.encodings[0].maxBitrate} bps, maintain-framerate`);
  } catch {
    await sender.setParameters(p).catch(() => {});
  }
}

function bindCursorDataChannel(cdc) {
  state.cursorDc = cdc;
  cdc.onopen = () => {
    log("info", "DataChannel", "Realtime low-latency cursor channel opened");
  };
  cdc.onmessage = (ev) => onControlMessage(JSON.parse(ev.data));
}

function dcSend(obj) {
  if (state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  }
}

function dcSendCursor(obj) {
  // Mouse input must use the reliable main channel. The realtime channel is
  // intentionally lossy and could drop the first movement after connecting.
  if (obj.t === "in" && state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  } else if (state.cursorDc && state.cursorDc.readyState === "open") {
    state.cursorDc.send(JSON.stringify(obj));
  } else if (state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  }
}

async function onControlMessage(msg) {
  if (state.role === "host") {
    if (msg.t === "in" && !state.remoteInputPaused) {
      state.lastRemoteInputAt = Date.now();
      window.deskly.inject(msg.e, { blockWinKey: state.settings.blockWinKey !== false });
    }
    if (msg.t === "cursor" && state.settings.mouseFollow && !state.remoteInputPaused) {
      if (Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        state.lastRemoteInputAt = Date.now();
        window.deskly.followCursor({ x: msg.x, y: msg.y });
      }
    }
    if (msg.t === "screen-size") {
      log("info", "Host", `Host adjusting capture resolution to ${msg.size}`);
      state.settings.screenSize = msg.size;
      $("set-screen-size").value = msg.size;
      if (state.hostVideoTrack) {
        try {
          await state.hostVideoTrack.applyConstraints(qualityConstraints(msg.size));
          log("info", "Host", `Applied dynamic resolution constraints for ${msg.size}`);
        } catch (e) {
          log("warn", "Host", `Failed to apply capture constraints: ${e.message}`);
        }
      }
    }
    if (msg.t === "settings") {
      state.settings = { ...state.settings, ...msg.settings };
      syncSessionUi();
    }
  }

  if (state.role === "controller") {
    if (msg.t === "host-cursor" && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      state.hostCursor = { x: msg.x, y: msg.y };

      if (state.settings.mouseFollow && !state.remoteInputPaused) {
        state.suppressSendMouseMoveUntil = Date.now() + 35;
        const g = getGeometry();
        const clientX = g.videoLeft + msg.x * g.videoWidth;
        const clientY = g.videoTop + msg.y * g.videoHeight;
        if (window.deskly?.followHostCursor) {
          window.deskly.followHostCursor(clientX, clientY);
        } else if (window.deskly?.setCursorScreenPos) {
          const wb = cachedWindowBounds;
          if (wb && wb.width) {
            const scale = wb.scaleFactor || 1;
            window.deskly.setCursorScreenPos(
              Math.round((wb.x + clientX) * scale),
              Math.round((wb.y + clientY) * scale)
            );
          }
        }
      }
    }
    if (msg.t === "input-feedback") {
      const wasBlocked = state.remoteInputPaused;
      state.remoteInputPaused = !!msg.paused;
      updateInputPill();
      if (wasBlocked !== state.remoteInputPaused) {
        setSessionFeedback(msg.paused ? "⛔ Host blocked your input" : "✅ Host allowed your input");
      }
    }
    if (msg.t === "settings") {
      state.settings = { ...state.settings, ...msg.settings };
      syncSessionUi();
    }
  }
}

window.deskly.onLocalCursor((pos) => {
  if (state.role === "host") {
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      dcSendCursor({ t: "host-cursor", x: pos.x, y: pos.y });
      if (state.settings.mouseFollow) {
        dcSendCursor({ t: "cursor", x: pos.x, y: pos.y });
      }
    }
  }
});

function enterSession(label) {
  state.wsInSession = true;
  show("view-session");
  $("session-label").textContent = label;
  updateInputPill();
  syncSessionUi();
  setScreenFit(state.screenFit);
  updateScreenSizeButtons();
  if (state.role !== "controller") {
    $("cursor-host")?.classList.add("hidden");
  }
}

function setScreenFit(mode) {
  state.screenFit = mode === "stretch" ? "stretch" : "adaptive";
  localStorage.setItem("desklyScreenFit", state.screenFit);
  video.classList.toggle("stretch", state.screenFit === "stretch");
  $("btn-fit-adaptive")?.classList.toggle("active", state.screenFit === "adaptive");
  $("btn-fit-stretch")?.classList.toggle("active", state.screenFit === "stretch");
  updateCursorPositions();
  log("info", "Screen", `Screen fit set to ${state.screenFit}`);
}

$("btn-fit-adaptive").onclick = () => setScreenFit("adaptive");
$("btn-fit-stretch").onclick = () => setScreenFit("stretch");

function updateScreenSizeButtons() {
  const current = state.settings.screenSize || "adaptive";
  $("btn-size-adaptive")?.classList.toggle("active", current === "adaptive");
  $("btn-size-1080p")?.classList.toggle("active", current === "1080p");
  $("btn-size-720p")?.classList.toggle("active", current === "720p");
}

async function setScreenResolution(size) {
  state.settings.screenSize = size;
  $("set-screen-size").value = size;
  updateScreenSizeButtons();
  log("info", "Screen", `Resolution set to ${size}`);

  if (state.role === "controller") {
    dcSend({ t: "screen-size", size });
    setSessionFeedback(`Resolution set to ${size.toUpperCase()}`);
  }

  if (state.role === "host" && state.hostVideoTrack) {
    try {
      await state.hostVideoTrack.applyConstraints(qualityConstraints(size));
      log("info", "Screen", `Host applied constraints for ${size}`);
    } catch (e) {
      log("warn", "Screen", `Could not apply constraints: ${e.message}`);
    }
  }

  try {
    await api("/api/settings", { method: "PATCH", body: { screenSize: size } });
  } catch { /* ignore */ }
}

$("btn-size-adaptive").onclick = () => setScreenResolution("adaptive");
$("btn-size-1080p").onclick = () => setScreenResolution("1080p");
$("btn-size-720p").onclick = () => setScreenResolution("720p");

let feedbackTimer = null;
function setSessionFeedback(text, durationMs = 2800) {
  const el = $("session-feedback");
  if (!el) return;
  el.textContent = text || "";
  if (feedbackTimer) clearTimeout(feedbackTimer);
  if (text && durationMs > 0) {
    feedbackTimer = setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, durationMs);
  }
}

function syncSessionUi() {
  const follow = !!state.settings.mouseFollow;
  $("session-follow-toggle").checked = follow;
  $("set-follow").checked = follow;
}

async function setMouseFollow(enabled) {
  state.settings.mouseFollow = !!enabled;
  syncSessionUi();
  setSessionFeedback(enabled ? "Follow cursors ON" : "Follow cursors OFF");
  dcSend({ t: "settings", settings: { mouseFollow: state.settings.mouseFollow } });
  try {
    await api("/api/settings", { method: "PATCH", body: { mouseFollow: state.settings.mouseFollow } });
    $("save-msg").textContent = "Mouse follow saved.";
  } catch (e) {
    $("save-msg").textContent = `Could not save: ${e.message}`;
  }
}

$("session-follow-toggle").onchange = () => setMouseFollow($("session-follow-toggle").checked);

function endSession(reason) {
  log("info", "Session", `Ending session: ${reason}`);
  state.wsInSession = false;
  clearIceRecoveryTimer();
  cleanupPeer();
  window.deskly.stopCursorLoop();
  video.srcObject = null;
  $("cursor-host")?.classList.add("hidden");
  state.hostCursor = null;
  paintHome();
  setStatus(reason);
}

function cleanupPeer() {
  try { state.cursorDc?.close(); } catch { /* ignore */ }
  try { state.dc?.close(); } catch { /* ignore */ }
  try { state.pc?.close(); } catch { /* ignore */ }
  if (state.hostVideoTrack) {
    try { state.hostVideoTrack.stop(); } catch { /* ignore */ }
    state.hostVideoTrack = null;
  }
  state.pc = null;
  state.dc = null;
  state.cursorDc = null;
  state.iceQueue = [];
}

function updateInputPill() {
  const el = $("input-state");
  if (!el) return;
  if (state.role === "host") {
    el.textContent = state.remoteInputPaused ? "Remote BLOCKED" : "Remote ON";
    el.className = "pill " + (state.remoteInputPaused ? "off" : "on");
    el.title = state.remoteInputPaused
      ? "Remote controller input is blocked. Click or press :qe (or Ctrl+Alt+E) to resume."
      : "Remote controller input is active. Click or press :qw (or Ctrl+Alt+Q) to pause.";
    el.style.cursor = "pointer";
  } else {
    el.textContent = state.remoteInputPaused ? "Host BLOCKED" : "Input ON";
    el.className = "pill " + (state.remoteInputPaused ? "off" : "on");
    el.title = state.remoteInputPaused ? "Host has blocked remote input" : "Remote input active";
    el.style.cursor = "default";
  }
}

function hostPauseRemoteInput() {
  if (state.role !== "host") return;
  if (state.remoteInputPaused) return;
  state.remoteInputPaused = true;
  log("info", "Host", "Host blocked remote input via :qw / shortcut");
  dcSend({ t: "input-feedback", paused: true });
  updateInputPill();
  setSessionFeedback("⛔ Remote input BLOCKED (:qw / Ctrl+Alt+Q)");
  window.deskly?.setRemoteInputPausedState?.(true);
}

function hostResumeRemoteInput() {
  if (state.role !== "host") return;
  if (!state.remoteInputPaused) return;
  state.remoteInputPaused = false;
  log("info", "Host", "Host resumed remote input via :qe / shortcut");
  dcSend({ t: "input-feedback", paused: false });
  updateInputPill();
  setSessionFeedback("✅ Remote input RESUMED (:qe / Ctrl+Alt+E)");
  window.deskly?.setRemoteInputPausedState?.(false);
}

$("input-state").onclick = () => {
  if (state.role === "host") {
    if (state.remoteInputPaused) hostResumeRemoteInput();
    else hostPauseRemoteInput();
  }
};

window.deskly.onHotkey((name) => {
  if (state.role === "host") {
    if (name === "pause") hostPauseRemoteInput();
    if (name === "resume") hostResumeRemoteInput();
  }
});

const video = $("remote-video");

function getVideoContentRect() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || state.screenFit === "stretch") {
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  const elementRatio = r.width / r.height;
  const videoRatio = vw / vh;
  let renderWidth, renderHeight, left, top;
  if (elementRatio > videoRatio) {
    renderHeight = r.height;
    renderWidth = r.height * videoRatio;
    left = r.left + (r.width - renderWidth) / 2;
    top = r.top;
  } else {
    renderWidth = r.width;
    renderHeight = r.width / videoRatio;
    left = r.left;
    top = r.top + (r.height - renderHeight) / 2;
  }
  return { left, top, width: renderWidth, height: renderHeight };
}

let cachedGeometry = null;

function updateCachedGeometry() {
  const stage = $("stage");
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const rect = getVideoContentRect();
  cachedGeometry = {
    videoLeft: rect.left,
    videoTop: rect.top,
    videoWidth: Math.max(1, rect.width),
    videoHeight: Math.max(1, rect.height),
    offsetX: rect.left - stageRect.left,
    offsetY: rect.top - stageRect.top,
  };
}

function getGeometry() {
  if (!cachedGeometry) updateCachedGeometry();
  return cachedGeometry;
}

function videoNorm(ev) {
  const g = getGeometry();
  const nx = (ev.clientX - g.videoLeft) / g.videoWidth;
  const ny = (ev.clientY - g.videoTop) / g.videoHeight;
  return {
    x: Math.max(0, Math.min(1, nx)),
    y: Math.max(0, Math.min(1, ny)),
    inside:
      ev.clientX >= g.videoLeft &&
      ev.clientX <= g.videoLeft + g.videoWidth &&
      ev.clientY >= g.videoTop &&
      ev.clientY <= g.videoTop + g.videoHeight,
  };
}

function renderHostCursor(_x, _y) {
  // Blue dot overlay removed completely. Host cursor is naturally displayed in video feed.
}

let cachedWindowBounds = null;
async function refreshWindowBounds() {
  if (window.deskly?.getWindowBounds) {
    cachedWindowBounds = await window.deskly.getWindowBounds().catch(() => null);
  }
}

function updateCursorPositions() {
  updateCachedGeometry();
  refreshWindowBounds();
}

window.addEventListener("resize", updateCursorPositions);
video.addEventListener("loadedmetadata", updateCursorPositions);
video.addEventListener("resize", updateCursorPositions);

let lastSentMouseAt = 0;

video.addEventListener("mousemove", (ev) => {
  if (state.role !== "controller") return;
  if (Date.now() < state.suppressSendMouseMoveUntil) return;

  const p = videoNorm(ev);

  if (state.inputArmed && !state.remoteInputPaused) {
    const now = performance.now();
    // 120 Hz rate limiter (~8ms between sends) for instantaneous cursor response without frame lag
    if (now - lastSentMouseAt >= 7) {
      lastSentMouseAt = now;
      dcSendCursor({ t: "in", e: { kind: "mouse-move", x: p.x, y: p.y } });
    }
  } else if (state.settings.mouseFollow) {
    dcSendCursor({ t: "cursor", x: p.x, y: p.y });
  }
});

video.addEventListener("mousedown", (ev) => {
  if (state.role !== "controller" || !state.inputArmed || state.remoteInputPaused) return;
  ev.preventDefault();
  const p = videoNorm(ev);
  dcSend({ t: "in", e: { kind: "mouse-button", button: ev.button, down: true, x: p.x, y: p.y } });
});

video.addEventListener("mouseup", (ev) => {
  if (state.role !== "controller" || !state.inputArmed || state.remoteInputPaused) return;
  const p = videoNorm(ev);
  dcSend({ t: "in", e: { kind: "mouse-button", button: ev.button, down: false, x: p.x, y: p.y } });
});

video.addEventListener("wheel", (ev) => {
  if (state.role !== "controller" || !state.inputArmed || state.remoteInputPaused) return;
  dcSend({ t: "in", e: { kind: "wheel", deltaY: Math.sign(ev.deltaY) } });
});

video.addEventListener("contextmenu", (ev) => ev.preventDefault());

const WIN_CODES = new Set(["MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

function localCommand(token) {
  if (state.role !== "host") return false;
  const t = String(token || "").toLowerCase().trim();
  if (t === "qw") {
    hostPauseRemoteInput();
    return true;
  }
  if (t === "qe") {
    hostResumeRemoteInput();
    return true;
  }
  return false;
}

window.addEventListener("keydown", (ev) => {
  const target = ev.target;
  const isInputFocused = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

  // ONLY HOST can trigger hotkeys and :qw / :qe command sequence
  if (state.role === "host") {
    if (ev.ctrlKey && ev.altKey && (ev.code === "KeyQ" || ev.code === "KeyE")) {
      ev.preventDefault();
      if (ev.code === "KeyQ") hostPauseRemoteInput();
      else hostResumeRemoteInput();
      return;
    }

    if (!isInputFocused && (state.cmd.length || ev.key === ":")) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === ":") {
        state.cmd = ":";
      } else if (ev.key === "Escape") {
        state.cmd = "";
      } else if (ev.key === "Enter") {
        localCommand(state.cmd.slice(1));
        state.cmd = "";
      } else if (ev.key === "Backspace") {
        state.cmd = state.cmd.slice(0, -1);
      } else if (ev.key.length === 1) {
        state.cmd += ev.key;
        const lower = state.cmd.toLowerCase();
        if (lower === ":qw" || lower === ":qe") {
          localCommand(state.cmd.slice(1));
          state.cmd = "";
        }
      }
      $("local-cmd")?.classList.toggle("hidden", !state.cmd);
      const cmdText = $("local-cmd-text");
      if (cmdText) cmdText.textContent = state.cmd.slice(1);
      return;
    }
    return;
  }

  // CONTROLLER handling: controller NEVER controls pause/resume, and remote typing is blocked if paused by host
  if (state.role !== "controller") return;
  if (state.remoteInputPaused) return;
  if (WIN_CODES.has(ev.code) || ev.key === "Meta") { ev.preventDefault(); return; }
  if (!state.inputArmed) return;
  if (ev.repeat) return;
  dcSend({ t: "in", e: { kind: "key", code: ev.code, down: true } });
});

window.addEventListener("keyup", (ev) => {
  if (state.role !== "controller") return;
  if (state.remoteInputPaused) return;
  if (WIN_CODES.has(ev.code) || ev.key === "Meta") { ev.preventDefault(); return; }
  if (!state.inputArmed) return;
  dcSend({ t: "in", e: { kind: "key", code: ev.code, down: false } });
});

// Logs modal handlers
async function openLogsModal() {
  $("modal-logs").classList.remove("hidden");
  await refreshLogs();
}

function closeLogsModal() {
  $("modal-logs").classList.add("hidden");
}

async function refreshLogs() {
  $("log-content").textContent = "Loading logs…";
  if (window.deskly?.getLogs) {
    try {
      const content = await window.deskly.getLogs();
      $("log-content").textContent = content || "No logs yet.";
      $("log-content").scrollTop = $("log-content").scrollHeight;
    } catch (e) {
      $("log-content").textContent = `Error reading logs: ${e.message}`;
    }
  } else {
    $("log-content").textContent = "Desktop logging interface not available in browser mode.";
  }
}

$("btn-open-logs").onclick = openLogsModal;
$("btn-settings-open-logs").onclick = openLogsModal;
$("btn-close-logs").onclick = closeLogsModal;
$("btn-refresh-logs").onclick = refreshLogs;

$("btn-clear-logs").onclick = async () => {
  if (window.deskly?.clearLogs) {
    await window.deskly.clearLogs();
    await refreshLogs();
  }
};

$("btn-open-log-file").onclick = async () => {
  if (window.deskly?.openLogFile) await window.deskly.openLogFile();
};

$("btn-settings-open-file").onclick = async () => {
  if (window.deskly?.openLogFile) await window.deskly.openLogFile();
};

$("modal-logs").addEventListener("click", (e) => {
  if (e.target === $("modal-logs")) closeLogsModal();
});

// Keep WS alive through proxies/NAT with a heartbeat ping every 15s
setInterval(() => sendWs({ type: "ping" }), 15000);

bootstrap().catch((err) => {
  setStatus("Cannot reach Deskly server. Start the API first.");
  log("error", "App", `Bootstrap error: ${err.message}`);
});
