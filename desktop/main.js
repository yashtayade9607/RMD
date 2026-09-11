const { app, BrowserWindow, Tray, Menu, nativeImage, safeStorage, desktopCapturer, globalShortcut, ipcMain, session, shell, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const input = require("./input-win");

const roleArg = process.argv.find((a) => a.startsWith("--role="));
const startRole = roleArg ? roleArg.split("=")[1] : "";
const apiArg = process.argv.find((a) => a.startsWith("--api-url="));

function configuredApiUrl() {
  if (apiArg) return apiArg.slice("--api-url=".length).trim().replace(/\s+/g, "").replace(/\/$/, "");
  const bundledConfig = app.isPackaged
    ? path.join(process.resourcesPath, "deskly.config.json")
    : path.join(__dirname, "..", "deskly.config.json");
  const userConfig = path.join(app.getPath("userData"), "deskly.config.json");
  // The per-user file takes priority, so an installed app can switch from a
  // local test server to the public deployment without reinstalling.
  for (const filePath of [userConfig, bundledConfig]) {
    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof config.apiUrl === "string") {
        const cleaned = config.apiUrl.replace(/\s+/g, "").replace(/\/$/, "");
        if (/^https?:\/\//i.test(cleaned)) {
          return cleaned;
        }
      }
    } catch {
      // Continue to the next configuration location.
    }
  }
  return "http://127.0.0.1:3780";
}

let mainWindow;
let cursorTimer;
let lastCursor;
let tray;
let isQuitting = false;

function getLogPaths() {
  const localPath = path.join(__dirname, "..", "deskly.log");
  let userPath = "";
  try {
    userPath = path.join(app.getPath("userData"), "deskly.log");
  } catch {
    userPath = localPath;
  }
  return { localPath, userPath };
}

function writeLog(level, category, message, data) {
  const now = new Date().toISOString();
  const dataStr = data !== undefined ? " " + (typeof data === "object" ? JSON.stringify(data) : String(data)) : "";
  const line = `[${now}] [${String(level).toUpperCase()}] [${category}] ${message}${dataStr}\n`;
  try {
    process.stdout.write(line);
  } catch {
    /* ignore */
  }
  const { localPath, userPath } = getLogPaths();
  try {
    fs.appendFileSync(localPath, line, "utf8");
  } catch {
    /* ignore */
  }
  if (userPath && userPath !== localPath) {
    try {
      fs.appendFileSync(userPath, line, "utf8");
    } catch {
      /* ignore */
    }
  }
}

writeLog("info", "Main", `Starting Deskly. Role: ${startRole || "unspecified"}, API: ${configuredApiUrl()}`);

const isHiddenArg = process.argv.some(
  (a) => a === "--hidden" || a === "--background" || a.startsWith("--hidden=") || a.startsWith("--background=")
);

let updateTrayMenu = null;

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1677c8"/><path d="M9 10h14v9H13l-4 4v-13z" fill="white"/><circle cx="14" cy="14.5" r="1.5" fill="#1677c8"/><circle cx="19" cy="14.5" r="1.5" fill="#1677c8"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("Deskly — Ready in background");

  updateTrayMenu = () => {
    const isVisible = mainWindow && mainWindow.isVisible();
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: isVisible ? "Hide to Tray (Background Mode)" : "Open Deskly",
        click: () => {
          if (isVisible) mainWindow.hide();
          else showWindow();
        },
      },
      { type: "separator" },
      { label: "Status: Online (Ready in Background)", enabled: false },
      { type: "separator" },
      {
        label: "Open Log File",
        click: () => {
          const { localPath, userPath } = getLogPaths();
          shell.openPath(fs.existsSync(localPath) ? localPath : userPath);
        },
      },
      { type: "separator" },
      {
        label: "Exit Deskly",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
  };

  updateTrayMenu();
  tray.on("click", () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
  tray.on("double-click", showWindow);
}

function createWindow() {
  let initialWidth = 1080;
  let initialHeight = 700;
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    if (primaryDisplay && primaryDisplay.workAreaSize) {
      const { width, height } = primaryDisplay.workAreaSize;
      // Responsively adapt to screen dimensions (e.g. 14-inch 1366x768 or scaled 1080p)
      initialWidth = Math.min(1100, Math.max(860, Math.floor(width * 0.9)));
      initialHeight = Math.min(740, Math.max(520, Math.floor(height * 0.88)));
    }
  } catch {
    /* fallback defaults */
  }

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 780,
    minHeight: 460,
    show: !isHiddenArg && startRole !== "host",
    backgroundColor: "#0b0f14",
    title: startRole === "host" ? "Deskly — Host" : startRole === "controller" ? "Deskly — Controller" : "Deskly",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // Prevents Electron from throttling WebRTC frames and timers in background
    },
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const t0 = Date.now();
    writeLog("info", "Main", "Screen sharing stream requested by renderer");
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      writeLog("info", "Main", `Screen source captured in ${Date.now() - t0}ms`, { sourceId: sources[0]?.id });
      callback({ video: sources[0] });
    } catch (err) {
      writeLog("error", "Main", `Screen capture error: ${err.message}`);
      callback({});
    }
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    writeLog("error", "Window", `Failed to load ${url}: [${code}] ${desc}`);
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    writeLog("error", "Window", `Renderer process crashed: ${details.reason} (exit: ${details.exitCode})`);
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const src = sourceId ? path.basename(sourceId) : "unknown";
    if (level === 3) {
      writeLog("error", "Renderer", `${message} (${src}:${line})`);
    } else if (level === 2) {
      writeLog("warn", "Renderer", `${message} (${src}:${line})`);
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { ...(startRole ? { role: startRole } : {}), apiUrl: configuredApiUrl() },
  });

  mainWindow.on("show", () => updateTrayMenu?.());
  mainWindow.on("hide", () => updateTrayMenu?.());

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function bindShortcuts() {
  globalShortcut.register("CommandOrControl+Alt+Q", () => {
    mainWindow?.webContents.send("deskly:hotkey", "pause");
  });
  globalShortcut.register("CommandOrControl+Alt+E", () => {
    mainWindow?.webContents.send("deskly:hotkey", "resume");
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // Remove default File/Edit/View/Window/Help menu bar
  createWindow();
  createTray();
  bindShortcuts();
});

app.on("activate", showWindow);

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  writeLog("info", "Main", "Deskly closing");
});

ipcMain.handle("deskly:role", () => startRole || "");

ipcMain.handle("deskly:show-window", () => {
  showWindow();
  return { ok: true };
});

ipcMain.handle("deskly:set-background", (_evt, enabled) => {
  if (enabled) mainWindow?.hide();
  else showWindow();
  return { ok: true, runningInBackground: !!enabled };
});

ipcMain.handle("deskly:inject", (_evt, event, options) => {
  try {
    input.applyEvent(event, options || {});
    return { ok: true };
  } catch (err) {
    writeLog("error", "Input", `Failed to inject event ${event?.kind}: ${err.message}`);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("deskly:cursor", () => input.cursorNormalized());

ipcMain.handle("deskly:follow-cursor", (_evt, posOrDx, dy) => {
  if (typeof posOrDx === "object" && posOrDx !== null) {
    const x = Number(posOrDx.x);
    const y = Number(posOrDx.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      try {
        input.setCursorNormalized(x, y);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  }
  const dx = Number(posOrDx);
  const dyVal = Number(dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dyVal)) return { ok: false, error: "Invalid cursor movement." };
  try {
    input.moveCursorBy(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dyVal)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("deskly:set-cursor-screen-pos", (_evt, sx, sy) => {
  try {
    const x = Number(sx);
    const y = Number(sy);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      input.setCursorPixels(x, y);
      return { ok: true };
    }
    return { ok: false, error: "Invalid coordinates" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("deskly:follow-host-cursor", (_evt, clientX, clientY) => {
  if (!mainWindow) return { ok: false };
  try {
    const cb = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(cb);
    const scale = display?.scaleFactor || 1;
    const targetX = Math.round((cb.x + Number(clientX)) * scale);
    const targetY = Math.round((cb.y + Number(clientY)) * scale);
    input.setCursorPixels(targetX, targetY);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("deskly:get-window-bounds", () => {
  if (!mainWindow) return { x: 0, y: 0, width: 0, height: 0, scaleFactor: 1 };
  const cb = mainWindow.getContentBounds();
  const display = screen.getDisplayMatching(cb);
  const scaleFactor = display?.scaleFactor || 1;
  return { x: cb.x, y: cb.y, width: cb.width, height: cb.height, scaleFactor };
});

ipcMain.handle("deskly:start-cursor-loop", (evt) => {
  if (cursorTimer) clearInterval(cursorTimer);
  lastCursor = input.getCursor();
  cursorTimer = setInterval(() => {
    // If the cursor was moved by remote injection from controller, do NOT broadcast it back!
    if (input.wasRecentInject(60)) {
      lastCursor = input.getCursor();
      return;
    }
    const pos = input.getCursor();
    const dx = pos.x - lastCursor.x;
    const dy = pos.y - lastCursor.y;
    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
      lastCursor = pos;
      const norm = input.cursorNormalized();
      evt.sender.send("deskly:local-cursor", { dx, dy, x: norm.x, y: norm.y });
    }
  }, 10);
});

ipcMain.handle("deskly:stop-cursor-loop", () => {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  lastCursor = null;
});

// Logging IPC
ipcMain.handle("deskly:log", (_evt, level, category, message, data) => {
  writeLog(level, category, message, data);
  return true;
});

ipcMain.handle("deskly:get-logs", () => {
  const { localPath, userPath } = getLogPaths();
  const filePath = fs.existsSync(localPath) ? localPath : userPath;
  try {
    if (!fs.existsSync(filePath)) return "No logs yet.";
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - 200 * 1024);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (err) {
    return `Error reading log file: ${err.message}`;
  }
});

ipcMain.handle("deskly:open-log-file", async () => {
  const { localPath, userPath } = getLogPaths();
  const target = fs.existsSync(localPath) ? localPath : userPath;
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `[${new Date().toISOString()}] [INFO] [System] Log file created.\n`, "utf8");
  }
  await shell.openPath(target);
  return true;
});

ipcMain.handle("deskly:clear-logs", () => {
  const { localPath, userPath } = getLogPaths();
  try { fs.writeFileSync(localPath, "", "utf8"); } catch {}
  try { if (userPath !== localPath) fs.writeFileSync(userPath, "", "utf8"); } catch {}
  return true;
});

function accessListPath() {
  return path.join(app.getPath("userData"), "deskly-access-list.json");
}

function readAccessList() {
  try { return JSON.parse(fs.readFileSync(accessListPath(), "utf8")); } catch { return {}; }
}

function encryptSecret(str) {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return "safe:" + safeStorage.encryptString(str).toString("base64");
  }
  return "b64:" + Buffer.from(str, "utf8").toString("base64");
}

function decryptSecret(cipher) {
  if (typeof cipher !== "string") return "";
  if (cipher.startsWith("safe:") && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher.slice(5), "base64"));
    } catch {
      return "";
    }
  }
  if (cipher.startsWith("b64:")) {
    try {
      return Buffer.from(cipher.slice(4), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(cipher, "base64"));
    } catch {
      /* ignore */
    }
  }
  try {
    return Buffer.from(cipher, "base64").toString("utf8");
  } catch {
    return "";
  }
}

ipcMain.handle("deskly:access-list", () => {
  const list = readAccessList();
  return Object.values(list).flatMap((entry) => {
    const password = decryptSecret(entry.secret);
    if (!password) return [];
    return [{ publicId: entry.publicId, username: entry.username || "Unknown device", password }];
  });
});

ipcMain.handle("deskly:save-access", (_evt, entry) => {
  const publicId = String(entry?.publicId || "").replace(/\D/g, "");
  const password = String(entry?.password || "");
  if (!/^\d{9}$/.test(publicId) || !password) throw new Error("Invalid saved access entry.");
  const list = readAccessList();
  list[publicId] = {
    publicId,
    username: String(entry.username || "Unknown device"),
    secret: encryptSecret(password),
    lastConnectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(accessListPath(), JSON.stringify(list, null, 2), "utf8");
  return true;
});

ipcMain.handle("deskly:remove-access", (_evt, publicId) => {
  const list = readAccessList();
  delete list[String(publicId || "").replace(/\D/g, "")];
  fs.writeFileSync(accessListPath(), JSON.stringify(list, null, 2), "utf8");
  return true;
});
