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
const KEYEVENTF_KEYUP = 0x0002;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const DESKLY_INJECTED_EXTRA_INFO = 0xDE5C17;

const POINT = koffi.struct("POINT", {
  x: "long",
  y: "long",
});

const KBDLLHOOKSTRUCT = koffi.struct("KBDLLHOOKSTRUCT", {
  vkCode: "uint32",
  scanCode: "uint32",
  flags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr",
});

const HOOKPROC = koffi.proto("intptr_t __stdcall HOOKPROC(int nCode, uintptr_t wParam, KBDLLHOOKSTRUCT *lParam)");

const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
const mouse_event = user32.func("void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");
const SetWindowsHookExW = user32.func("void * __stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hmod, uint32 dwThreadId)");
const UnhookWindowsHookEx = user32.func("int __stdcall UnhookWindowsHookEx(void *hhk)");
const CallNextHookEx = user32.func("intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, KBDLLHOOKSTRUCT *lParam)");
const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vKey)");
const GetKeyState = user32.func("int16 __stdcall GetKeyState(int vKey)");
const MapVirtualKeyW = user32.func("uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)");

const RAWINPUTDEVICELIST = koffi.struct("RAWINPUTDEVICELIST", {
  hDevice: "uintptr",
  dwType: "uint32",
});

const GetRawInputDeviceList = user32.func("uint32 __stdcall GetRawInputDeviceList(uintptr_t pList, _Inout_ uint32* pCount, uint32 cbSize)");
const GetRawInputDeviceInfoW = user32.func("uint32 __stdcall GetRawInputDeviceInfoW(uintptr hDevice, uint32 uiCommand, uintptr pData, _Inout_ uint32* pcbSize)");

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;

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
const activeInjectedKeys = new Set();

function markInject() {
  lastInjectAt = Date.now();
}

function isWinKey(code) {
  return code === "MetaLeft" || code === "MetaRight" || code === "OSLeft" || code === "OSRight";
}

function releaseAllKeys() {
  for (const vk of activeInjectedKeys) {
    try {
      keybd_event(vk, 0, KEYEVENTF_KEYUP, DESKLY_INJECTED_EXTRA_INFO);
    } catch {
      /* ignore */
    }
  }
  activeInjectedKeys.clear();
  try {
    mouse_event(MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP, 0, 0, 0, DESKLY_INJECTED_EXTRA_INFO);
  } catch {
    /* ignore */
  }
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
    mouse_event(flags, 0, 0, 0, DESKLY_INJECTED_EXTRA_INFO);
    return;
  }
  if (evt.kind === "wheel") {
    markInject();
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, Math.round(evt.deltaY * -120), DESKLY_INJECTED_EXTRA_INFO);
    return;
  }
  if (evt.kind === "key") {
    if (blockWin && isWinKey(evt.code)) return;
    const vk = CODE_TO_VK[evt.code];
    if (!vk) return;
    markInject();
    if (evt.down) {
      activeInjectedKeys.add(vk);
      keybd_event(vk, 0, 0, DESKLY_INJECTED_EXTRA_INFO);
    } else {
      activeInjectedKeys.delete(vk);
      keybd_event(vk, 0, KEYEVENTF_KEYUP, DESKLY_INJECTED_EXTRA_INFO);
    }
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

// ══════════════════════════════════════════════════════════════════════════════
//  WINDOWS LOW-LEVEL KEYBOARD HOOK (Isolates Host keystrokes for 4x Pause / 4x Resume)
// ══════════════════════════════════════════════════════════════════════════════

function normalizeVk(vk) {
  if (vk === 0xA2 || vk === 0xA3) return 0x11; // VK_CONTROL
  if (vk === 0xA4 || vk === 0xA5) return 0x12; // VK_MENU / Alt
  if (vk === 0xA0 || vk === 0xA1) return 0x10; // VK_SHIFT
  return vk;
}

const SHORTCUT_KEY_DEFS = {
  ctrl: { id: "ctrl", name: "Control (Ctrl)", vks: [0x11], isLed: false },
  alt: { id: "alt", name: "Alt", vks: [0x12], isLed: false },
  shift: { id: "shift", name: "Shift", vks: [0x10], isLed: false },
  caps: { id: "caps", name: "Caps Lock (LED)", vks: [0x14], isLed: true },
  touchpad: { id: "touchpad", name: "Trackpad / Touchpad (LED)", vks: [0x97], isLed: true },
  mute: { id: "mute", name: "Audio Mute (LED)", vks: [0xAD], isLed: true },
  micmute: { id: "micmute", name: "Microphone Mute (LED)", vks: [0xF9], isLed: true },
  fnlock: { id: "fnlock", name: "Fn Lock (LED)", vks: [0x86], isLed: true },
  num: { id: "num", name: "Num Lock (LED)", vks: [0x90], isLed: true },
  scroll: { id: "scroll", name: "Scroll Lock (LED)", vks: [0x91], isLed: true },
  space: { id: "space", name: "Spacebar", vks: [0x20], isLed: false },
  escape: { id: "escape", name: "Escape (Esc)", vks: [0x1b], isLed: false },
  tab: { id: "tab", name: "Tab", vks: [0x09], isLed: false },
  f1: { id: "f1", name: "F1 Key", vks: [0x70], isLed: false },
  f2: { id: "f2", name: "F2 Key", vks: [0x71], isLed: false },
  f3: { id: "f3", name: "F3 Key", vks: [0x72], isLed: false },
  f4: { id: "f4", name: "F4 Key", vks: [0x73], isLed: false },
  f5: { id: "f5", name: "F5 Key", vks: [0x74], isLed: false },
  f6: { id: "f6", name: "F6 Key", vks: [0x75], isLed: false },
  f7: { id: "f7", name: "F7 Key", vks: [0x76], isLed: false },
  f8: { id: "f8", name: "F8 Key", vks: [0x77], isLed: false },
  f9: { id: "f9", name: "F9 Key", vks: [0x78], isLed: false },
  f10: { id: "f10", name: "F10 Key", vks: [0x79], isLed: false },
  f11: { id: "f11", name: "F11 Key", vks: [0x7A], isLed: false },
  f12: { id: "f12", name: "F12 Key", vks: [0x7B], isLed: false },
};

let hKeyboardHook = null;
let hookCallbackPtr = null;
let pollTimer = null;
let onSequenceAction = null;

let configuredPauseKeyId = "ctrl";
let configuredResumeKeyId = "alt";

let pauseTapCount = 0;
let resumeTapCount = 0;
let lastHostKeyTime = 0;
let pollKeyStateMap = {};

function setShortcutKeys(pauseKeyId, resumeKeyId) {
  if (
    pauseKeyId &&
    SHORTCUT_KEY_DEFS[pauseKeyId] &&
    resumeKeyId &&
    SHORTCUT_KEY_DEFS[resumeKeyId] &&
    pauseKeyId !== resumeKeyId
  ) {
    configuredPauseKeyId = pauseKeyId;
    configuredResumeKeyId = resumeKeyId;
    pauseTapCount = 0;
    resumeTapCount = 0;
    pollKeyStateMap = {};
    return true;
  }
  return false;
}

function isVkMatch(rawVk, keyId) {
  const vk = normalizeVk(rawVk);
  const def = SHORTCUT_KEY_DEFS[keyId];
  if (!def || !def.vks) return false;
  return def.vks.includes(vk);
}

let hostPressedKeys = new Set();

function keyboardHookProc(nCode, wParam, lParam) {
  if (nCode >= 0) {
    const flags = lParam.flags;
    const extraInfo = lParam.dwExtraInfo;
    const isDesklyInjected =
      ((flags & 0x10) !== 0) || // LLKHF_INJECTED
      ((flags & 0x02) !== 0) || // LLKHF_LOWER_IL_INJECTED
      (Number(extraInfo) === DESKLY_INJECTED_EXTRA_INFO);

    // A remote session may inject cursor updates continuously.  Do not use the
    // time-based injection guard here: it would discard genuine host keys for
    // as long as cursor movement continues (and could leave a key marked down).
    // Low-level hook events contain explicit injected flags / extra info, which
    // is sufficient to exclude Deskly's own synthetic key events.
    if (!isDesklyInjected) {
      const rawVk = lParam.vkCode;
      const vk = normalizeVk(rawVk);
      const isKeyDown = (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN);
      const isKeyUp = (wParam === WM_KEYUP || wParam === WM_SYSKEYUP);

      if (isKeyDown) {
        if (!hostPressedKeys.has(vk)) {
          hostPressedKeys.add(vk);
          registerHostTap(vk);
        }
      } else if (isKeyUp) {
        hostPressedKeys.delete(vk);
      }
    }
  }
  return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
}

function registerHostTap(vk) {
  const now = Date.now();
  if (now - lastHostKeyTime > 2500) {
    pauseTapCount = 0;
    resumeTapCount = 0;
  }
  lastHostKeyTime = now;

  if (isVkMatch(vk, configuredPauseKeyId)) {
    resumeTapCount = 0;
    pauseTapCount++;
    if (pauseTapCount >= 4) {
      pauseTapCount = 0;
      if (onSequenceAction) onSequenceAction("pause");
    }
  } else if (isVkMatch(vk, configuredResumeKeyId)) {
    pauseTapCount = 0;
    resumeTapCount++;
    if (resumeTapCount >= 4) {
      resumeTapCount = 0;
      if (onSequenceAction) onSequenceAction("resume");
    }
  } else {
    if (![0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c].includes(vk)) {
      pauseTapCount = 0;
      resumeTapCount = 0;
    }
  }
}

function pollShortcutKeys() {
  if (wasRecentInject(350)) return;

  const pauseDef = SHORTCUT_KEY_DEFS[configuredPauseKeyId];
  const resumeDef = SHORTCUT_KEY_DEFS[configuredResumeKeyId];

  if (pauseDef && pauseDef.vks) {
    const isPauseDown = pauseDef.vks.some((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0);
    const wasPauseDown = !!pollKeyStateMap["pause"];
    if (isPauseDown && !wasPauseDown) {
      pollKeyStateMap["pause"] = true;
      if (!hKeyboardHook) {
        registerHostTap(pauseDef.vks[0]);
      }
    } else if (!isPauseDown && wasPauseDown) {
      pollKeyStateMap["pause"] = false;
    }
  }

  if (resumeDef && resumeDef.vks) {
    const isResumeDown = resumeDef.vks.some((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0);
    const wasResumeDown = !!pollKeyStateMap["resume"];
    if (isResumeDown && !wasResumeDown) {
      pollKeyStateMap["resume"] = true;
      if (!hKeyboardHook) {
        registerHostTap(resumeDef.vks[0]);
      }
    } else if (!isResumeDown && wasResumeDown) {
      pollKeyStateMap["resume"] = false;
    }
  }
}

function startKeyboardHook(actionCallback) {
  onSequenceAction = actionCallback;

  if (!hKeyboardHook) {
    try {
      hookCallbackPtr = koffi.register(keyboardHookProc, koffi.pointer(HOOKPROC));
      hKeyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, hookCallbackPtr, null, 0);
    } catch (err) {
      console.error("[Hook] Failed to install WH_KEYBOARD_LL hook:", err.message);
    }
  }

  if (!pollTimer) {
    pollTimer = setInterval(pollShortcutKeys, 15);
  }
}

function stopKeyboardHook() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (hKeyboardHook) {
    try {
      UnhookWindowsHookEx(hKeyboardHook);
    } catch {
      /* ignore */
    }
    hKeyboardHook = null;
  }
  if (hookCallbackPtr) {
    try {
      koffi.unregister(hookCallbackPtr);
    } catch {
      /* ignore */
    }
    hookCallbackPtr = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  KEYBOARD INDICATOR LEDS (Caps Lock, Num Lock, Scroll Lock)
// ══════════════════════════════════════════════════════════════════════════════

const LED_DEFS = {
  caps: { id: "caps", name: "Caps Lock LED", vk: 0x14, scan: 0x3a, ext: false },
  touchpad: { id: "touchpad", name: "Trackpad / Touchpad LED", vk: 0x97, scan: 0x00, ext: true },
  mute: { id: "mute", name: "Audio Mute LED", vk: 0xAD, scan: 0x20, ext: true },
  micmute: { id: "micmute", name: "Microphone Mute LED", vk: 0xF9, scan: 0x00, ext: true },
  fnlock: { id: "fnlock", name: "Fn Lock LED", vk: 0x86, scan: 0x00, ext: true },
  num: { id: "num", name: "Num Lock LED", vk: 0x90, scan: 0x45, ext: true },
  scroll: { id: "scroll", name: "Scroll Lock LED", vk: 0x91, scan: 0x46, ext: false },
};

function toggleLedKey(def) {
  const scanCode = def.scan || MapVirtualKeyW(def.vk, 0) || 0;
  const flagsDown = def.ext ? 0x0001 : 0;
  const flagsUp = (def.ext ? 0x0001 : 0) | KEYEVENTF_KEYUP;
  markInject();
  keybd_event(def.vk, scanCode, flagsDown, DESKLY_INJECTED_EXTRA_INFO);
  keybd_event(def.vk, scanCode, flagsUp, DESKLY_INJECTED_EXTRA_INFO);
}

function getSystemKeyboardLedCount() {
  try {
    const count = [32];
    const listBuf = Buffer.alloc(32 * 16);
    if (GetRawInputDeviceList(koffi.address(listBuf), count, 16) === 0 || count[0] === 0) {
      return 1;
    }
    let maxIndicators = 0;
    const infoBuf = Buffer.alloc(32);
    const sz = [32];
    for (let i = 0; i < count[0]; i++) {
      const dwType = listBuf.readUInt32LE(i * 16 + 8);
      if (dwType === 1) { // 1 = RIM_TYPEKEYBOARD
        const hDev = listBuf.readBigUInt64LE(i * 16);
        infoBuf.writeUInt32LE(32, 0);
        sz[0] = 32;
        const res = GetRawInputDeviceInfoW(hDev, 0x2000000b, koffi.address(infoBuf), sz);
        if (res !== 4294967295) {
          const indicators = infoBuf.readUInt32LE(24);
          if (indicators > maxIndicators) {
            maxIndicators = indicators;
          }
        }
      }
    }
    return maxIndicators;
  } catch {
    return 1;
  }
}

function getAvailableLeds() {
  const leds = [];
  const systemLedCount = getSystemKeyboardLedCount();
  const hasFullDesktopKeyboard = systemLedCount >= 3;

  for (const [id, def] of Object.entries(LED_DEFS)) {
    try {
      if (id === "caps" || id === "touchpad" || id === "mute" || id === "micmute" || id === "fnlock") {
        leds.push({ id: def.id, name: def.name });
      } else if (id === "num" || id === "scroll") {
        if (hasFullDesktopKeyboard) {
          leds.push({ id: def.id, name: def.name });
        }
      }
    } catch {
      /* ignore */
    }
  }
  return leds;
}

let activeBlinkTimer = null;
let activeBlinkStopTimer = null;
let activeBlinkRestore = null;

function stopActiveBlink() {
  if (activeBlinkTimer) {
    clearInterval(activeBlinkTimer);
    activeBlinkTimer = null;
  }
  if (activeBlinkStopTimer) {
    clearTimeout(activeBlinkStopTimer);
    activeBlinkStopTimer = null;
  }
  if (activeBlinkRestore) {
    try {
      activeBlinkRestore();
    } catch {}
    activeBlinkRestore = null;
  }
}

function blinkLed(ledId, durationMs = 3000) {
  stopActiveBlink();
  const def = LED_DEFS[ledId];
  if (!def) return false;

  let toggleCount = 0;
  activeBlinkRestore = () => {
    // If toggled an odd number of times, toggle once more to restore original lock state
    if (toggleCount % 2 !== 0) {
      toggleLedKey(def);
    }
  };

  // Toggle immediately on start
  toggleLedKey(def);
  toggleCount++;

  // Toggle every 250ms for the duration
  activeBlinkTimer = setInterval(() => {
    toggleLedKey(def);
    toggleCount++;
  }, 250);

  activeBlinkStopTimer = setTimeout(() => {
    stopActiveBlink();
  }, Math.max(500, durationMs));

  return true;
}

function getAvailableShortcutKeys() {
  const availableLeds = getAvailableLeds().map((l) => l.id);
  const keys = [];
  for (const [id, def] of Object.entries(SHORTCUT_KEY_DEFS)) {
    if (def.isLed) {
      if (availableLeds.includes(id)) {
        keys.push({ id: def.id, name: def.name, isLed: true });
      }
    } else {
      keys.push({ id: def.id, name: def.name, isLed: false });
    }
  }
  return keys;
}

module.exports = {
  applyEvent,
  blinkLed,
  cursorNormalized,
  getAvailableLeds,
  getAvailableShortcutKeys,
  getCursor,
  moveCursorBy,
  releaseAllKeys,
  screenBounds,
  setCursorNormalized,
  setCursorPixels,
  setShortcutKeys,
  startKeyboardHook,
  stopKeyboardHook,
  toPixels,
  wasRecentInject,
};
