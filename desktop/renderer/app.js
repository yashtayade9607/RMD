const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
  iceCandidatePoolSize: 2,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  sdpSemantics: "unified-plan",
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const API = params.get("apiUrl") || "http://127.0.0.1:3780";
const SIGNAL = API.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const state = {
  token: localStorage.getItem("desklyToken") || "",
  role: params.get("role") || "controller",
  isHosting: false,
  me: null,
  settings: {
    mouseFollow: true,
    blockWinKey: true,
    videoQuality: "balanced",
    screenSize: "adaptive",
    hostRunInBackground: false,
    pauseLed: localStorage.getItem("desklyPauseLed") || "none",
    resumeLed: localStorage.getItem("desklyResumeLed") || "none",
    recentDevices: [],
  },
  ws: null,
  wsPingTimer: null,
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
  connectedHostUsername: "",
  connectedCallerUsername: "",
  presenceMap: new Map(),
};

function triggerLedBlink(action) {
  const count = action === "pause" ? 2 : 3;
  const led = action === "pause" ? state.settings.pauseLed : state.settings.resumeLed;
  if (led && led !== "none" && window.deskly?.blinkLed) {
    window.deskly.blinkLed(led, count).catch(() => {});
  }
}

async function initLedDropdowns() {
  if (!window.deskly?.getAvailableLeds) return;
  try {
    const leds = await window.deskly.getAvailableLeds();
    const pauseSelect = $("set-pause-led");
    const resumeSelect = $("set-resume-led");
    if (pauseSelect && leds && leds.length) {
      const curr = state.settings.pauseLed || pauseSelect.value || "none";
      pauseSelect.innerHTML = '<option value="none">None (Disabled)</option>' +
        leds.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
      pauseSelect.value = curr;
      pauseSelect.onchange = async () => {
        state.settings.pauseLed = pauseSelect.value;
        localStorage.setItem("desklyPauseLed", pauseSelect.value);
        await saveSettings();
      };
    }
    if (resumeSelect && leds && leds.length) {
      const curr = state.settings.resumeLed || resumeSelect.value || "none";
      resumeSelect.innerHTML = '<option value="none">None (Disabled)</option>' +
        leds.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
      resumeSelect.value = curr;
      resumeSelect.onchange = async () => {
        state.settings.resumeLed = resumeSelect.value;
        localStorage.setItem("desklyResumeLed", resumeSelect.value);
        await saveSettings();
      };
    }
    if ($("btn-test-pause-led")) {
      $("btn-test-pause-led").onclick = () => {
        const led = state.settings.pauseLed || $("set-pause-led")?.value;
        if (led && led !== "none" && window.deskly?.blinkLed) {
          window.deskly.blinkLed(led, 2).catch(() => {});
        }
      };
    }
    if ($("btn-test-resume-led")) {
      $("btn-test-resume-led").onclick = () => {
        const led = state.settings.resumeLed || $("set-resume-led")?.value;
        if (led && led !== "none" && window.deskly?.blinkLed) {
          window.deskly.blinkLed(led, 3).catch(() => {});
        }
      };
    }
  } catch (err) {
    log("warn", "LED", `Failed to initialize LED list: ${err.message}`);
  }
}

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
  const host = state.me?.devices?.host || state.me?.devices?.controller;
  $("host-id").textContent = host?.publicIdDisplay || (host?.publicId ? displayId(host.publicId) : "—");
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
  if ($("set-pause-led")) $("set-pause-led").value = state.settings.pauseLed || "none";
  if ($("set-resume-led")) $("set-resume-led").value = state.settings.resumeLed || "none";
  renderRecentDevices();
}

function renderRecentDevices() {
  const dbDevices = state.settings.recentDevices || [];
  const localDevices = state.savedAccess || [];
  const deviceMap = new Map();

  for (const item of localDevices) {
    const id = String(item.publicId || "").replace(/\D/g, "");
    if (id) {
      const isOnline = state.presenceMap.has(id) ? !!state.presenceMap.get(id) : !!item.online;
      deviceMap.set(id, {
        publicId: id,
        username: item.username || "Unknown device",
        password: item.password || "",
        online: isOnline,
        lastConnectedAt: item.lastConnectedAt || null,
      });
    }
  }

  for (const item of dbDevices) {
    const id = String(item.publicId || "").replace(/\D/g, "");
    if (id) {
      const existing = deviceMap.get(id);
      const isOnline = state.presenceMap.has(id) ? !!state.presenceMap.get(id) : !!item.online;
      deviceMap.set(id, {
        publicId: id,
        username: item.username || existing?.username || "Unknown device",
        password: item.accessPassword || existing?.password || "",
        online: isOnline,
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
    dot.title = device.online ? "Device is Online" : "Device is Offline";

    const name = document.createElement("span");
    name.className = "recent-username";
    name.textContent = device.username ? `@${device.username.replace(/^@/, "")}` : "Unknown device";

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
  setStatus("Deskly Online — Ready to connect or host");
}

async function bootstrap() {
  log("info", "App", "Deskly starting up");
  const startRole = await window.deskly.getStartRole();
  if (startRole) state.role = startRole;
  if (!state.token) {
    show("view-login");
    setStatus("Log in or create account");
    await window.deskly.showWindow();
    return;
  }
  try {
    const me = await api("/api/me");
    state.me = me;
    // Preserve local LED selections only for older database records that do
    // not yet have these newly persisted settings. Database values win once set.
    state.settings = { ...state.settings, ...(me.settings || {}) };
    state.savedAccess = await window.deskly.accessList();
    await initLedDropdowns();
    paintHome();
    await openSocket();
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
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.hostAccessPassword = data.devices?.host?.accessPassword || data.devices?.controller?.accessPassword || "";
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
    await openSocket();
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
  log("info", "Role", `Switched preferred role to ${role}`);
  state.role = role;
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
    pauseLed: $("set-pause-led")?.value || state.settings.pauseLed || "none",
    resumeLed: $("set-resume-led")?.value || state.settings.resumeLed || "none",
    recentDevices: state.settings.recentDevices || [],
  };
  localStorage.setItem("desklyPauseLed", state.settings.pauseLed);
  localStorage.setItem("desklyResumeLed", state.settings.resumeLed);
  log("info", "Settings", "Saving settings", state.settings);
  const res = await api("/api/settings", { method: "PATCH", body: state.settings });
  if (res.settings) state.settings = { ...state.settings, ...res.settings };
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
if ($("set-pause-led")) $("set-pause-led").onchange = saveSettings;
if ($("set-resume-led")) $("set-resume-led").onchange = saveSettings;
if ($("btn-test-pause-led")) {
  $("btn-test-pause-led").onclick = () => {
    const led = $("set-pause-led")?.value;
    if (led && led !== "none" && window.deskly?.blinkLed) {
      window.deskly.blinkLed(led, 2);
      setSessionFeedback(`Blinking ${led} twice...`);
    } else {
      setSessionFeedback("No Pause LED selected");
    }
  };
}
if ($("btn-test-resume-led")) {
  $("btn-test-resume-led").onclick = () => {
    const led = $("set-resume-led")?.value;
    if (led && led !== "none" && window.deskly?.blinkLed) {
      window.deskly.blinkLed(led, 3);
      setSessionFeedback(`Blinking ${led} thrice...`);
    } else {
      setSessionFeedback("No Resume LED selected");
    }
  };
}

$("btn-copy-id").onclick = () => {
  const host = state.me?.devices?.host || state.me?.devices?.controller;
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
    await openSocket();
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
  if (state.wsPingTimer) {
    clearInterval(state.wsPingTimer);
    state.wsPingTimer = null;
  }
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
}

function scheduleWsReconnect() {
  stopWsReconnect();
  if (!state.token) return;
  const delay = state.wsReconnectDelay;
  state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 2, 30000);
  log("info", "Signaling", `WS reconnect scheduled in ${delay}ms`);
  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = null;
    openSocket(true).catch(() => {});
  }, delay);
}

function openSocket(isReconnect = false) {
  return new Promise((resolve) => {
    stopWsReconnect();
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
      state.wsReconnectDelay = 1000;
      log("info", "Signaling", `WebSocket connected successfully`);
      if (state.wsPingTimer) clearInterval(state.wsPingTimer);
      state.wsPingTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === 1) {
          sendWs({ type: "ping" });
        }
      }, 5000);
      if (isReconnect && state.wsInSession) {
        setStatus(state.isHosting ? "Host online" : "Connected (60 FPS)");
        setSessionFeedback("🔄 Signaling reconnected");
      } else {
        setStatus("Deskly Online — Ready to connect or host");
      }
      resolve();
    };

    ws.onclose = (ev) => {
      if (state.wsPingTimer) {
        clearInterval(state.wsPingTimer);
        state.wsPingTimer = null;
      }
      if (ws._desklyManaged) return;
      log("warn", "Signaling", `WS closed (code=${ev.code})`);
      if (state.wsInSession) {
        setSessionFeedback("⚠️ Signaling dropped — reconnecting…");
      } else {
        setStatus("Signaling disconnected — reconnecting…");
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
  if (msg.type === "presence") {
    // msg: { userId, username, publicId, role, online } or publicIds array
    if (msg.publicId) {
      const cleanId = String(msg.publicId).replace(/\D/g, "");
      state.presenceMap.set(cleanId, !!msg.online);
    }
    for (const pubId of (msg.publicIds || [])) {
      const cleanId = String(pubId).replace(/\D/g, "");
      state.presenceMap.set(cleanId, !!msg.online);
    }
    renderRecentDevices();
  }

  if (msg.type === "start-session") {
    log("info", "Signaling", "Received incoming session request — acting as Host", msg);
    state.isHosting = true;
    state.connectedCallerUsername = msg.caller?.username || "Controller";
    state.settings = { ...state.settings, ...(msg.settings || {}) };
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
      state.connectedHostUsername = msg.device?.username || "";
      rememberConnectedDevice($("connect-id").value, $("connect-pass").value, msg.device?.username);
      const hostDisplay = state.connectedHostUsername ? `@${state.connectedHostUsername}` : displayId($("connect-id").value);
      $("session-label").textContent = `Host: ${hostDisplay}`;
      setStatus("Connecting…");
      setSessionFeedback("");
    }
  }

  if (msg.type === "signal") {
    if (msg.data?.kind === "input-feedback") {
      applySharedInputPause(msg.data.paused, msg.data.source || "remote");
    } else {
      await handleRtc(msg.data);
    }
  }

  if (msg.type === "hangup") {
    log("info", "Signaling", "Peer sent explicit hangup — ending session");
    endSession("Peer disconnected");
  }

  if (msg.type === "peer-gone") {
    log("warn", "Signaling", `Peer WS dropped — watching WebRTC state`);
    if (state.wsInSession) {
      setSessionFeedback("⚠️ Peer signal dropped — checking connection…");
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
    if (state.isHosting && state.pc && state.ws?.readyState === 1) {
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
  const cleanUsername = username || "Unknown device";
  await window.deskly.saveAccess({ publicId, password, username: cleanUsername });
  state.savedAccess = await window.deskly.accessList();

  const others = (state.settings.recentDevices || []).filter((item) => item.publicId !== publicId);
  state.settings.recentDevices = [
    { publicId, username: cleanUsername, accessPassword: password, lastConnectedAt: new Date().toISOString() },
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
  const targetId = String(id || "").replace(/\D/g, "");
  const pass = String(password || "");
  if (!targetId || !pass) {
    $("connect-error").textContent = "Please enter Remote Device ID and access password.";
    return;
  }
  log("info", "Controller", `Initiating connection to Device ${targetId}`);
  state.isHosting = false;
  await prepareControllerPeer();
  sendWs({ type: "connect", hostId: targetId, password: pass });
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
  state.isHosting = true;
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
      const callerDisplay = state.connectedCallerUsername ? `@${state.connectedCallerUsername}` : "Controller";
      $("session-label").textContent = `Hosting (connected to ${callerDisplay})`;
    } else if (cs === "disconnected") {
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
    const callerDisplay = state.connectedCallerUsername ? `@${state.connectedCallerUsername}` : "";
    enterSession(callerDisplay ? `Hosting (${callerDisplay})` : "Hosting — screen shared");
    window.deskly.startCursorLoop();
  } catch (err) {
    log("error", "WebRTC", `Failed to start host screen sharing: ${err.message}`);
    endSession("Screen share failed: " + err.message);
  }
}

async function prepareControllerPeer() {
  log("info", "WebRTC", "Controller preparing peer connection");
  state.isHosting = false;
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
      const hostDisplay = state.connectedHostUsername
        ? `@${state.connectedHostUsername}`
        : ($("connect-id")?.value ? displayId($("connect-id").value) : "");
      if (hostDisplay) $("session-label").textContent = `Host: ${hostDisplay}`;
      refreshWindowBounds();
    } else if (cs === "disconnected") {
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
      } catch { /* ignore */ }
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sendWs({ type: "signal", data: { kind: "ice", candidate: e.candidate } });
  };
  const hostDisplay = state.connectedHostUsername ? `@${state.connectedHostUsername}` : "Connecting…";
  enterSession(`Host: ${hostDisplay}`);
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
    if (!state.isHosting) {
      state.inputArmed = true;
      setSessionFeedback("Input ready — Host controls access.");
    } else {
      dcSend({ t: "input-feedback", paused: state.remoteInputPaused });
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
  if (obj.t === "in" && state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  } else if (state.cursorDc && state.cursorDc.readyState === "open") {
    state.cursorDc.send(JSON.stringify(obj));
  } else if (state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  }
}

async function onControlMessage(msg) {
  // Pause state is shared: either side can pause or resume the session.
  // Handle it before the host's blocked-input guard so a resume always works.
  if (msg.t === "input-feedback") {
    applySharedInputPause(msg.paused, msg.source || "remote");
    return;
  }

  if (state.isHosting) {
    if (state.remoteInputPaused) {
      // Host paused/blocked remote controller: strictly discard all input and cursor movements
      if (msg.t === "settings") {
        state.settings = { ...state.settings, ...msg.settings };
        syncSessionUi();
      } else if (msg.t === "in" || msg.t === "cursor") {
        // Echo blocked state back to ensure controller stays locked
        dcSend({ t: "input-feedback", paused: true });
      }
      return;
    }
    if (msg.t === "in") {
      state.lastRemoteInputAt = Date.now();
      window.deskly.inject(msg.e, { blockWinKey: state.settings.blockWinKey !== false });
    }
    if (msg.t === "cursor" && state.settings.mouseFollow) {
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

  if (!state.isHosting) {
    if (msg.t === "host-cursor" && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
      state.hostCursor = { x: msg.x, y: msg.y };
      if (state.settings.mouseFollow && !state.remoteInputPaused && state.inputArmed) {
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
    if (msg.t === "settings") {
      state.settings = { ...state.settings, ...msg.settings };
      syncSessionUi();
    }
  }
}

window.deskly.onLocalCursor((pos) => {
  if (state.isHosting) {
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
  if (state.isHosting) {
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

  if (!state.isHosting) {
    dcSend({ t: "screen-size", size });
    setSessionFeedback(`Resolution set to ${size.toUpperCase()}`);
  }

  if (state.isHosting && state.hostVideoTrack) {
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
  state.isHosting = false;
  clearIceRecoveryTimer();
  cleanupPeer();
  window.deskly.stopCursorLoop();
  if (window.deskly?.releaseAllKeys) window.deskly.releaseAllKeys();
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
  const btn = $("btn-toggle-input");

  if (state.isHosting) {
    if (el) {
      el.textContent = state.remoteInputPaused ? "Remote BLOCKED" : "Remote ON";
      el.className = "pill " + (state.remoteInputPaused ? "off" : "on");
      el.title = "Host remote input status. Click to toggle.";
    }
    if (btn) {
      btn.disabled = false;
      if (state.remoteInputPaused) {
        btn.textContent = "Allow Remote";
        btn.className = "input-ctrl-btn btn-resume";
        btn.title = "Allow remote controller input (Ctrl+Alt+E)";
      } else {
        btn.textContent = "Block Remote";
        btn.className = "input-ctrl-btn btn-pause";
        btn.title = "Block remote controller input (Ctrl+Alt+Q)";
      }
    }
  } else {
    if (state.remoteInputPaused) {
      if (el) {
        el.textContent = "Input PAUSED";
        el.className = "pill off";
        el.title = "Remote input is paused. Click to resume.";
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Start Input";
        btn.className = "input-ctrl-btn btn-resume";
        btn.title = "Resume remote input";
      }
    } else {
      if (el) {
        el.textContent = state.inputArmed ? "Input ON" : "Input PAUSED";
        el.className = "pill " + (state.inputArmed ? "on" : "off");
        el.title = "Controller input state. Click to toggle.";
      }
      if (btn) {
        btn.disabled = false;
        if (state.inputArmed) {
          btn.textContent = "Pause Input";
          btn.className = "input-ctrl-btn btn-pause";
          btn.title = "Pause sending keyboard & mouse input";
        } else {
          btn.textContent = "Start Input";
          btn.className = "input-ctrl-btn btn-resume";
          btn.title = "Start sending keyboard & mouse input";
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  INPUT CONTROL & SHORTCUTS (Host & Controller)
// ══════════════════════════════════════════════════════════════════════════════

function sendSharedInputPause(paused, source) {
  const message = { t: "input-feedback", paused: !!paused, source };
  dcSend(message);
  dcSendCursor(message);
  sendWs({ type: "signal", data: { kind: "input-feedback", paused: !!paused, source } });
}

function applySharedInputPause(paused, source = "remote") {
  const nextPaused = !!paused;
  const changed = state.remoteInputPaused !== nextPaused || (!state.isHosting && state.inputArmed === nextPaused);
  state.remoteInputPaused = nextPaused;

  // On the controller, the shared state also controls whether input events
  // leave this device. On the host it controls whether incoming events apply.
  if (!state.isHosting) state.inputArmed = !nextPaused;
  if (nextPaused && state.isHosting && window.deskly?.releaseAllKeys) {
    window.deskly.releaseAllKeys();
  }

  updateInputPill();
  if (changed) {
    const actor = source === "host" ? "Host" : source === "controller" ? "Controller" : "remote device";
    log("info", "Input", `Shared input ${nextPaused ? "paused" : "resumed"} by ${actor}`);
    setSessionFeedback(nextPaused ? `⛔ Remote input PAUSED by ${actor}` : `✅ Remote input RESUMED by ${actor}`);
    triggerLedBlink(nextPaused ? "pause" : "resume");
  }
}

function hostPauseRemoteInput() {
  if (state.remoteInputPaused) {
    log("info", "Shortcut", "Pause ignored: remote input is already blocked");
    return;
  }
  state.remoteInputPaused = true;
  log("info", "Host", "Host blocked remote input");
  if (window.deskly?.releaseAllKeys) window.deskly.releaseAllKeys();
  sendSharedInputPause(true, "host");
  updateInputPill();
  setSessionFeedback("⛔ Remote input BLOCKED (Ctrl+Alt+E to allow)");
  triggerLedBlink("pause");
}

function hostResumeRemoteInput() {
  if (!state.remoteInputPaused) {
    log("info", "Shortcut", "Resume ignored: remote input is already allowed");
    return;
  }
  state.remoteInputPaused = false;
  log("info", "Host", "Host resumed remote input");
  sendSharedInputPause(false, "host");
  updateInputPill();
  setSessionFeedback("✅ Remote input ALLOWED (Ctrl+Alt+Q to block)");
  triggerLedBlink("resume");
}

function controllerPauseInput() {
  state.inputArmed = false;
  state.remoteInputPaused = true;
  log("info", "Controller", "Controller paused sending input");
  // Release any active modifier keys so host does not keep them stuck down
  dcSend({ t: "in", e: { kind: "key", code: "ControlLeft", down: false } });
  dcSend({ t: "in", e: { kind: "key", code: "ControlRight", down: false } });
  dcSend({ t: "in", e: { kind: "key", code: "AltLeft", down: false } });
  dcSend({ t: "in", e: { kind: "key", code: "AltRight", down: false } });
  sendSharedInputPause(true, "controller");
  updateInputPill();
  setSessionFeedback("Input PAUSED");
  triggerLedBlink("pause");
}

function controllerResumeInput() {
  state.inputArmed = true;
  state.remoteInputPaused = false;
  log("info", "Controller", "Controller resumed sending input");
  sendSharedInputPause(false, "controller");
  updateInputPill();
  setSessionFeedback("Input ON");
  triggerLedBlink("resume");
}

// Controller GUI buttons to start & pause input
const btnToggleInput = $("btn-toggle-input");
if (btnToggleInput) {
  btnToggleInput.onclick = () => {
    if (state.isHosting) {
      if (state.remoteInputPaused) hostResumeRemoteInput();
      else hostPauseRemoteInput();
    } else {
      if (state.inputArmed) controllerPauseInput();
      else controllerResumeInput();
    }
  };
}

const inputStatePill = $("input-state");
if (inputStatePill) {
  inputStatePill.onclick = () => {
    if (state.isHosting) {
      if (state.remoteInputPaused) hostResumeRemoteInput();
      else hostPauseRemoteInput();
    } else {
      if (state.inputArmed) controllerPauseInput();
      else controllerResumeInput();
    }
  };
}

window.deskly.onHotkey((name) => {
  // Global shortcuts fire on every machine. Only the host responds; the
  // controller uses the toolbar button.
  log("info", "Shortcut", `Received ${name} shortcut`, {
    role: state.role,
    isHosting: state.isHosting,
    inSession: state.wsInSession,
  });
  if (!state.isHosting) {
    log("warn", "Shortcut", `${name} ignored: this Deskly instance is not the active host`);
    return;
  }
  if (name === "pause") hostPauseRemoteInput();
  if (name === "resume") hostResumeRemoteInput();
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
  if (state.isHosting || !state.inputArmed || state.remoteInputPaused) return;
  if (Date.now() < state.suppressSendMouseMoveUntil) return;

  const p = videoNorm(ev);
  const now = performance.now();
  if (now - lastSentMouseAt >= 7) {
    lastSentMouseAt = now;
    dcSendCursor({ t: "in", e: { kind: "mouse-move", x: p.x, y: p.y } });
  }
});

video.addEventListener("mousedown", (ev) => {
  if (state.isHosting || !state.inputArmed || state.remoteInputPaused) return;
  ev.preventDefault();
  const p = videoNorm(ev);
  dcSend({ t: "in", e: { kind: "mouse-button", button: ev.button, down: true, x: p.x, y: p.y } });
});

video.addEventListener("mouseup", (ev) => {
  if (state.isHosting || !state.inputArmed || state.remoteInputPaused) return;
  const p = videoNorm(ev);
  dcSend({ t: "in", e: { kind: "mouse-button", button: ev.button, down: false, x: p.x, y: p.y } });
});

video.addEventListener("wheel", (ev) => {
  if (state.isHosting || !state.inputArmed || state.remoteInputPaused) return;
  dcSend({ t: "in", e: { kind: "wheel", deltaY: Math.sign(ev.deltaY) } });
});

video.addEventListener("contextmenu", (ev) => ev.preventDefault());

const WIN_CODES = new Set(["MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

window.addEventListener("keydown", (ev) => {
  // Host-only hotkeys Ctrl+Alt+Q (block remote) / Ctrl+Alt+E (allow remote)
  if (state.isHosting && ev.ctrlKey && ev.altKey && (ev.code === "KeyQ" || ev.code === "KeyE")) {
    ev.preventDefault();
    log("info", "Shortcut", `Window shortcut activated: Ctrl+Alt+${ev.code === "KeyQ" ? "Q" : "E"}`);
    if (ev.code === "KeyQ") hostPauseRemoteInput();
    else hostResumeRemoteInput();
    return;
  }

  if (state.isHosting) return;
  if (WIN_CODES.has(ev.code) || ev.key === "Meta") { ev.preventDefault(); return; }
  if (!state.inputArmed || state.remoteInputPaused) return;
  if (ev.repeat) return;
  dcSend({ t: "in", e: { kind: "key", code: ev.code, down: true } });
});

window.addEventListener("keyup", (ev) => {
  if (state.isHosting) return;
  if (WIN_CODES.has(ev.code) || ev.key === "Meta") { ev.preventDefault(); return; }
  if (!state.inputArmed || state.remoteInputPaused) return;
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

// Presence auto-refresh when on Home view
setInterval(async () => {
  if (state.token && !state.wsInSession) {
    try {
      const me = await api("/api/me");
      if (me?.settings?.recentDevices) {
        state.settings.recentDevices = me.settings.recentDevices;
        renderRecentDevices();
      }
    } catch {
      /* ignore */
    }
  }
}, 8000);

// Keep WS alive through proxies/NAT with a heartbeat ping every 15s
setInterval(() => sendWs({ type: "ping" }), 15000);

bootstrap().catch((err) => {
  setStatus("Cannot reach Deskly server. Start the API first.");
  log("error", "App", `Bootstrap error: ${err.message}`);
});
