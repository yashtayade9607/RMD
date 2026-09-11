import bcrypt from "bcryptjs";
import { Device, Settings, User } from "./models.js";
import { verifyToken } from "./auth.js";

// Signaling only: WebRTC carries screen and controls directly between PCs.
// Each socket is keyed by account, so different users cannot replace a Host.
export function attachSignaling(app) {
  const sockets = new Map();
  // Peer references are stored per session key so reconnects can re-attach
  const peers = new Map();    // key -> peer socket
  // Grace timers: if a socket closes, wait before sending peer-gone
  const goneTimers = new Map(); // key -> setTimeout handle
  const GONE_GRACE_MS = 8000;  // 8s grace window for reconnects

  const socketKey = (userId, role) => `${userId}:${role}`;

  function send(socket, payload) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  async function setOnline(userId, role, online) {
    await Device.findOneAndUpdate(
      { ownerId: userId, role },
      { $set: { online, lastSeenAt: new Date() } }
    );
  }

  app.get("/ws", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const token = url.searchParams.get("token");
    const role = url.searchParams.get("role");
    let user;
    try {
      user = verifyToken(token || "");
    } catch {
      socket.close(4001, "auth");
      return;
    }
    if (role !== "host" && role !== "controller") {
      socket.close(4002, "role");
      return;
    }

    const key = socketKey(user.sub, role);

    // If there was a pending peer-gone timer for this key, cancel it —
    // the client reconnected before the grace window expired.
    if (goneTimers.has(key)) {
      clearTimeout(goneTimers.get(key));
      goneTimers.delete(key);
    }

    // Close old socket if still open (replaced by fresh reconnect)
    const previous = sockets.get(key);
    if (previous && previous !== socket) {
      try { previous.close(4000, "replaced"); } catch { /* ignore */ }
    }
    sockets.set(key, socket);

    // Re-attach to existing peer session if one exists
    const existingPeer = peers.get(key);
    if (existingPeer && existingPeer.readyState === 1) {
      socket.peer = existingPeer;
      // Also update the peer's reference to point to the fresh socket
      const peerKey = existingPeer._desklyKey;
      if (peerKey) {
        existingPeer.peer = socket;
        peers.set(peerKey, socket);
      }
    } else {
      socket.peer = null;
      peers.delete(key);
    }

    socket._desklyKey = key;
    setOnline(user.sub, role, true);
    send(socket, { type: "hello", role });

    socket.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "ping") {
        send(socket, { type: "pong", t: Date.now() });
        return;
      }

      if (role === "controller" && msg.type === "connect") {
        const host = await Device.findOne({ publicId: String(msg.hostId || "").replace(/\s/g, ""), role: "host" });
        if (!host) return send(socket, { type: "connect-result", ok: false, error: "Unknown ID." });
        if (!(await bcrypt.compare(String(msg.password || ""), host.accessPasswordHash))) {
          return send(socket, { type: "connect-result", ok: false, error: "Wrong password." });
        }
        const hostKey = socketKey(String(host.ownerId), "host");
        const hostSocket = sockets.get(hostKey);
        if (!hostSocket || hostSocket.readyState !== 1) {
          return send(socket, { type: "connect-result", ok: false, error: "The controlled PC is not online." });
        }
        // Link peers both ways and register in peer map for reconnect re-attach
        socket.peer = hostSocket;
        hostSocket.peer = socket;
        peers.set(key, hostSocket);
        peers.set(hostKey, socket);
        const settings = await Settings.findOne({ userId: host.ownerId });
        const owner = await User.findById(host.ownerId).select("username");
        send(socket, {
          type: "connect-result",
          ok: true,
          device: { publicId: host.publicId, username: owner?.username || "Unknown device" },
        });
        send(hostSocket, {
          type: "start-session",
          settings: settings
            ? {
                mouseFollow: settings.mouseFollow,
                blockWinKey: settings.blockWinKey,
                videoQuality: settings.videoQuality,
                screenSize: settings.screenSize || "adaptive",
              }
            : { mouseFollow: false, blockWinKey: true, videoQuality: "balanced", screenSize: "adaptive" },
        });
        return;
      }

      if (msg.type === "signal") send(socket.peer, { type: "signal", data: msg.data });
      if (msg.type === "hangup") {
        // Explicit hangup — clear peer state immediately, no grace window
        send(socket.peer, { type: "hangup" });
        const peerKey = socket.peer?._desklyKey;
        if (peerKey) {
          peers.delete(peerKey);
          if (socket.peer) socket.peer.peer = null;
        }
        peers.delete(key);
        socket.peer = null;
      }
    });

    socket.on("close", () => {
      // Only remove from sockets map if this is still the active socket
      if (sockets.get(key) === socket) sockets.delete(key);
      setOnline(user.sub, role, false);

      // Don't immediately fire peer-gone — give the client grace window to reconnect
      if (socket.peer) {
        const peerSocket = socket.peer;
        const peerKey = peerSocket._desklyKey;
        const timer = setTimeout(() => {
          goneTimers.delete(key);
          // Only fire peer-gone if the socket hasn't reconnected by now
          if (sockets.get(key) !== socket && !sockets.has(key)) {
            // Clean up peer map
            peers.delete(key);
            if (peerKey) peers.delete(peerKey);
            if (peerSocket.peer === socket) peerSocket.peer = null;
            send(peerSocket, { type: "peer-gone", role });
          }
        }, GONE_GRACE_MS);
        goneTimers.set(key, timer);
      }
    });
  });
}
