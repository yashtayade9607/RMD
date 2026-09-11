const koffi = require("koffi");

const user32 = koffi.load("user32.dll");

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

const POINT = koffi.struct("POINT", {
  x: "long",
  y: "long",
});

const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
const mouse_event = user32.func("void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");

let cachedBounds = null;
let lastBoundsCheckAt = 0;

function screenBounds() {
  const now = Date.now();
  if (!cachedBounds || now - lastBoundsCheckAt > 1000) {
    lastBoundsCheckAt = now;
    cachedBounds = {
      x: GetSystemMetrics(SM_XVIRTUALSCREEN),
      y: GetSystemMetrics(SM_YVIRTUALSCREEN),
      w: GetSystemMetrics(SM_CXVIRTUALSCREEN) || 1920,
      h: GetSystemMetrics(SM_CYVIRTUALSCREEN) || 1080,
    };
  }
  return cachedBounds;
}

const staticPoint = {};
function getCursor() {
  GetCursorPos(staticPoint);
  return { x: staticPoint.x, y: staticPoint.y };
}

function moveCursorBy(dx, dy) {
  const b = screenBounds();
  const c = getCursor();
  const x = Math.max(b.x, Math.min(b.x + b.w - 1, c.x + Math.round(dx)));
  const y = Math.max(b.y, Math.min(b.y + b.h - 1, c.y + Math.round(dy)));
  markInject();
  SetCursorPos(x, y);
}

function toPixels(nx, ny) {
  const b = screenBounds();
  const clampedX = Math.max(0, Math.min(1, Number(nx) || 0));
  const clampedY = Math.max(0, Math.min(1, Number(ny) || 0));
  return {
    px: Math.round(b.x + clampedX * (b.w - 1)),
    py: Math.round(b.y + clampedY * (b.h - 1)),
    ax: Math.round(clampedX * 65535),
    ay: Math.round(clampedY * 65535),
  };
}

function setCursorNormalized(nx, ny) {
  const p = toPixels(nx, ny);
  markInject();
  SetCursorPos(p.px, p.py);
}

const CODE_TO_VK = {
  Escape: 0x1b,
  Digit0: 0x30,
  Digit1: 0x31,
  Digit2: 0x32,
  Digit3: 0x33,
  Digit4: 0x34,
  Digit5: 0x35,
  Digit6: 0x36,
  Digit7: 0x37,
  Digit8: 0x38,
  Digit9: 0x39,
  KeyA: 0x41,
  KeyB: 0x42,
  KeyC: 0x43,
  KeyD: 0x44,
  KeyE: 0x45,
  KeyF: 0x46,
  KeyG: 0x47,
  KeyH: 0x48,
  KeyI: 0x49,
  KeyJ: 0x4a,
  KeyK: 0x4b,
  KeyL: 0x4c,
  KeyM: 0x4d,
  KeyN: 0x4e,
  KeyO: 0x4f,
  KeyP: 0x50,
  KeyQ: 0x51,
  KeyR: 0x52,
  KeyS: 0x53,
  KeyT: 0x54,
  KeyU: 0x55,
  KeyV: 0x56,
  KeyW: 0x57,
  KeyX: 0x58,
  KeyY: 0x59,
  KeyZ: 0x5a,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
  Tab: 0x09,
  CapsLock: 0x14,
  ShiftLeft: 0x10,
  ShiftRight: 0x10,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  Space: 0x20,
  Enter: 0x0d,
  Backspace: 0x08,
  Delete: 0x2e,
  Insert: 0x2d,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Backquote: 0xc0,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,
};

let lastInjectAt = 0;

function markInject() {
  lastInjectAt = Date.now();
}

function isWinKey(code) {
  return code === "MetaLeft" || code === "MetaRight" || code === "OSLeft" || code === "OSRight";
}

function applyEvent(evt, options = {}) {
  const blockWin = options.blockWinKey !== false;
  if (evt.kind === "cursor-delta") {
    moveCursorBy(evt.dx, evt.dy);
    return;
  }
  if (evt.kind === "cursor-pos") {
    setCursorNormalized(evt.x, evt.y);
    return;
  }
  if (evt.kind === "mouse-move" || evt.kind === "cursor-follow") {
    const p = toPixels(evt.x, evt.y);
    markInject();
    SetCursorPos(p.px, p.py);
    return;
  }
  if (evt.kind === "mouse-button") {
    if (typeof evt.x === "number" && typeof evt.y === "number") {
      const p = toPixels(evt.x, evt.y);
      SetCursorPos(p.px, p.py);
    }
    let flags = 0;
    if (evt.button === 0) flags = evt.down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    else if (evt.button === 2) flags = evt.down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
    else flags = evt.down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
    markInject();
    mouse_event(flags, 0, 0, 0, 0);
    return;
  }
  if (evt.kind === "wheel") {
    markInject();
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, Math.round(evt.deltaY * -120), 0);
    return;
  }
  if (evt.kind === "key") {
    if (blockWin && isWinKey(evt.code)) return;
    const vk = CODE_TO_VK[evt.code];
    if (!vk) return;
    markInject();
    keybd_event(vk, 0, evt.down ? 0 : KEYEVENTF_KEYUP, 0);
  }
}

function wasRecentInject(ms = 350) {
  return Date.now() - lastInjectAt < ms;
}

function cursorNormalized() {
  const b = screenBounds();
  const c = getCursor();
  const w = Math.max(b.w, 1);
  const h = Math.max(b.h, 1);
  return {
    x: Math.max(0, Math.min(1, (c.x - b.x) / w)),
    y: Math.max(0, Math.min(1, (c.y - b.y) / h)),
  };
}

function setCursorPixels(x, y) {
  markInject();
  SetCursorPos(Math.round(x), Math.round(y));
}

const GetAsyncKeyState = user32.func("short __stdcall GetAsyncKeyState(int vKey)");

const VK_SHIFT = 0x10;
const VK_OEM_1 = 0xba; // ; : on US/standard keyboards
const VK_KEY_Q = 0x51;
const VK_KEY_W = 0x57;
const VK_KEY_E = 0x45;

let watcherTimer = null;
let watcherSeqState = 0; // 0: idle, 1: saw ':', 2: saw ':q'
let watcherSeqTimer = null;
let prevShift = false;
let prevColon = false;
let prevQ = false;
let prevW = false;
let prevE = false;

function resetWatcherSeq() {
  watcherSeqState = 0;
  if (watcherSeqTimer) {
    clearTimeout(watcherSeqTimer);
    watcherSeqTimer = null;
  }
}

function startHostKeyWatcher(onAction) {
  if (watcherTimer) return;
  resetWatcherSeq();
  prevShift = false;
  prevColon = false;
  prevQ = false;
  prevW = false;
  prevE = false;

  // Track ALL alphanumeric / printable keys so we can detect unexpected presses
  // We sample ALL keys in the 0x20–0x5A range (Space, digits, letters) plus common punctuation
  const ALL_TRACKED_VKS = [
    VK_OEM_1, VK_KEY_Q, VK_KEY_W, VK_KEY_E,
    // Every other letter A-Z except Q, W, E
    0x41, 0x42, 0x43, 0x44, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b,
    0x4c, 0x4d, 0x4e, 0x4f, 0x50,       0x52, 0x53, 0x54, 0x55,
    0x56,             0x58, 0x59, 0x5a,
    // Digits 0-9
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    // Space, Enter, Tab, Backspace, punctuation
    0x20, 0x0d, 0x09, 0x08,
    0xbc, 0xbe, 0xbf, 0xdb, 0xdd, 0xdc, 0xde, 0xc0, 0xbd, 0xbb,
  ];

  // Previous states for all tracked keys
  const prevKeys = new Map(ALL_TRACKED_VKS.map(vk => [vk, false]));

  watcherTimer = setInterval(() => {
    try {
      // Ignore keys that were simulated / injected from remote controller
      if (wasRecentInject(300)) return;

      const isShift    = (GetAsyncKeyState(VK_SHIFT)   & 0x8000) !== 0;
      const isColonKey = (GetAsyncKeyState(VK_OEM_1)   & 0x8000) !== 0;
      const isQ        = (GetAsyncKeyState(VK_KEY_Q)   & 0x8000) !== 0;
      const isW        = (GetAsyncKeyState(VK_KEY_W)   & 0x8000) !== 0;
      const isE        = (GetAsyncKeyState(VK_KEY_E)   & 0x8000) !== 0;

      // Check if ANY unexpected key was freshly pressed this tick
      let unexpectedPress = false;
      for (const vk of ALL_TRACKED_VKS) {
        const isDown = (GetAsyncKeyState(vk) & 0x8000) !== 0;
        const wasDown = prevKeys.get(vk);
        if (isDown && !wasDown) {
          // A key was freshly pressed. Determine if it's "unexpected" for current state.
          const isColon = vk === VK_OEM_1 && isShift;
          const isQKey  = vk === VK_KEY_Q;
          const isWKey  = vk === VK_KEY_W;
          const isEKey  = vk === VK_KEY_E;

          if (watcherSeqState === 0) {
            // In idle — only `:` (Shift+OEM_1) starts the sequence
            if (!isColon) { /* idle, fine */ }
          } else if (watcherSeqState === 1) {
            // Waiting for Q — any other key is unexpected
            if (!isQKey) { unexpectedPress = true; }
          } else if (watcherSeqState === 2) {
            // Waiting for W or E — any other key is unexpected
            if (!isWKey && !isEKey) { unexpectedPress = true; }
          }
        }
        prevKeys.set(vk, isDown);
      }

      if (unexpectedPress) {
        resetWatcherSeq();
        return;
      }

      const pressColon = isColonKey && !prevColon && isShift;
      const pressQ     = isQ && !prevQ;
      const pressW     = isW && !prevW;
      const pressE     = isE && !prevE;

      prevShift = isShift;
      prevColon = isColonKey;
      prevQ = isQ;
      prevW = isW;
      prevE = isE;

      if (pressColon) {
        watcherSeqState = 1; // Saw ':'
        if (watcherSeqTimer) clearTimeout(watcherSeqTimer);
        watcherSeqTimer = setTimeout(resetWatcherSeq, 3000);
      } else if (watcherSeqState === 1 && pressQ) {
        watcherSeqState = 2; // Saw ':q'
        if (watcherSeqTimer) clearTimeout(watcherSeqTimer);
        watcherSeqTimer = setTimeout(resetWatcherSeq, 3000);
      } else if (watcherSeqState === 2) {
        if (pressW) {
          resetWatcherSeq();
          if (typeof onAction === "function") onAction("pause");
        } else if (pressE) {
          resetWatcherSeq();
          if (typeof onAction === "function") onAction("resume");
        }
      }
    } catch {
      // Safety net
    }
  }, 25);
}

function stopHostKeyWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  resetWatcherSeq();
}

function releaseAllModifiers() {
  const vks = [0x10, 0x11, 0x12, 0x5b, 0x5c]; // VK_SHIFT, VK_CONTROL, VK_MENU (Alt), VK_LWIN, VK_RWIN
  for (const vk of vks) {
    try {
      keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  applyEvent,
  cursorNormalized,
  getCursor,
  moveCursorBy,
  releaseAllModifiers,
  screenBounds,
  setCursorNormalized,
  setCursorPixels,
  startHostKeyWatcher,
  stopHostKeyWatcher,
  toPixels,
  wasRecentInject,
};
