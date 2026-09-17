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

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;

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
//  WINDOWS LOW-LEVEL KEYBOARD HOOK (Isolates Host keystrokes for 4x Ctrl / 4x Alt)
// ══════════════════════════════════════════════════════════════════════════════

let hKeyboardHook = null;
let hookCallbackPtr = null;
let onSequenceAction = null;

let hostCtrlTapCount = 0;
let hostAltTapCount = 0;
let lastHostKeyTime = 0;

function keyboardHookProc(nCode, wParam, lParam) {
  if (nCode >= 0 && (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN)) {
    const flags = lParam.flags;
    const extraInfo = lParam.dwExtraInfo;
    const isInjected = ((flags & 1) !== 0) || (extraInfo === DESKLY_INJECTED_EXTRA_INFO);

    // ONLY process physical Host keystrokes — ignore controller injected input!
    if (!isInjected) {
      const vk = lParam.vkCode;
      const now = Date.now();
      if (now - lastHostKeyTime > 1500) {
        hostCtrlTapCount = 0;
        hostAltTapCount = 0;
      }
      lastHostKeyTime = now;

      // VK_CONTROL (0x11), VK_LCONTROL (0xA2), VK_RCONTROL (0xA3)
      if (vk === 0x11 || vk === 0xA2 || vk === 0xA3) {
        hostAltTapCount = 0;
        hostCtrlTapCount++;
        if (hostCtrlTapCount >= 4) {
          hostCtrlTapCount = 0;
          if (onSequenceAction) onSequenceAction("pause");
        }
      // VK_MENU / Alt (0x12), VK_LMENU (0xA4), VK_RMENU (0xA5)
      } else if (vk === 0x12 || vk === 0xA4 || vk === 0xA5) {
        hostCtrlTapCount = 0;
        hostAltTapCount++;
        if (hostAltTapCount >= 4) {
          hostAltTapCount = 0;
          if (onSequenceAction) onSequenceAction("resume");
        }
      } else {
        hostCtrlTapCount = 0;
        hostAltTapCount = 0;
      }
    }
  }
  return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
}

function startKeyboardHook(actionCallback) {
  if (hKeyboardHook) return;
  onSequenceAction = actionCallback;
  try {
    hookCallbackPtr = koffi.register(keyboardHookProc, koffi.pointer(HOOKPROC));
    hKeyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, hookCallbackPtr, null, 0);
  } catch (err) {
    console.error("[Hook] Failed to install WH_KEYBOARD_LL hook:", err.message);
  }
}

function stopKeyboardHook() {
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

module.exports = {
  applyEvent,
  cursorNormalized,
  getCursor,
  moveCursorBy,
  releaseAllKeys,
  screenBounds,
  setCursorNormalized,
  setCursorPixels,
  startKeyboardHook,
  stopKeyboardHook,
  toPixels,
  wasRecentInject,
};
