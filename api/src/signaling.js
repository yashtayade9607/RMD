import bcrypt from "bcryptjs";
import { Device, Settings, User } from "./models.js";
import { verifyToken } from "./auth.js";

// Signaling only: WebRTC carries screen and controls directly between PCs.
// Each socket is keyed by account, so different users cannot replace a Host.
export function attachSignaling(app) {
  const sockets = new Map();         // key -> socket
  const socketsByPublicId = new Map(); // publicId -> socket
  const socketsByOwner = new Map();    // userId -> Set of sockets
  // Peer references are stored per session key so reconnects can re-attach
  const peers = new Map();             // key -> peer socket
  // Grace timers: if a socket closes, wait before sending peer-gone
  const goneTimers = new Map();        // key -> setTimeout handle
  const GONE_GRACE_MS = 8000;          // 8s grace window for reconnects

  const socketKey = (userId, role, id) => `${userId}:${role}:${id || "default"}`;

  function send(socket, payload) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  async function setOnline(userId, role, online) {
    await Device.updateMany(
      { ownerId: userId },
      { $set: { online, lastSeenAt: new Date() } }
    ).catch(() => {});
  }

  app.get("/ws", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const token = url.searchParams.get("token");
    const role = url.searchParams.get("role") || "host";
    const clientPublicId = String(url.searchParams.get("publicId") || "").replace(/\D/g, "");
    let user;
    try {
      user = verifyToken(token || "");
    } catch {
      socket.close(4001, "auth");
      return;
    }

    const userId = String(user.sub);
    const connId = Math.random().toString(36).slice(2, 9);
    const key = socketKey(userId, role, connId);

    // If there was a pending peer-gone timer for this user/role, cancel it
    for (const [timerKey, timer] of goneTimers.entries()) {
      if (timerKey.startsWith(`${userId}:${role}`)) {
        clearTimeout(timer);
        goneTimers.delete(timerKey);
      }
    }

    sockets.set(key, socket);
    if (!socketsByOwner.has(userId)) socketsByOwner.set(userId, new Set());
    socketsByOwner.get(userId).add(socket);

    if (clientPublicId) {
      socketsByPublicId.set(clientPublicId, socket);
    }
    // Also associate any devices owned by this user
    Device.find({ ownerId: userId }).then((devs) => {
      for (const dev of devs) {
        if (!socketsByPublicId.has(dev.publicId)) {
          socketsByPublicId.set(dev.publicId, socket);
        }
      }
    }).catch(() => {});

    // Re-attach to existing peer session if one exists for this user
    const existingPeer = peers.get(key);
    if (existingPeer && existingPeer.readyState === 1) {
      socket.peer = existingPeer;
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
    socket._desklyUserId = userId;
    socket._desklyRole = role;
    socket._desklyPublicId = clientPublicId;

    setOnline(userId, role, true);
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

      // Allow connection regardless of whether role is host or controller
      if (msg.type === "connect") {
        const targetId = String(msg.hostId || "").replace(/\D/g, "");
        if (!targetId) {
          return send(socket, { type: "connect-result", ok: false, error: "Please enter a valid Device ID." });
        }

        // Find device in DB
        const targetDev = await Device.findOne({ publicId: targetId });
        if (!targetDev) {
          return send(socket, { type: "connect-result", ok: false, error: "Unknown Device ID." });
        }

        // Validate password against this device or any device belonging to target owner
        let passOk = false;
        if (targetDev.accessPasswordHash) {
          passOk = await bcrypt.compare(String(msg.password || ""), targetDev.accessPasswordHash);
        }
        if (!passOk) {
          const userDevs = await Device.find({ ownerId: targetDev.ownerId });
          for (const d of userDevs) {
            if (d.accessPasswordHash && (await bcrypt.compare(String(msg.password || ""), d.accessPasswordHash))) {
              passOk = true;
              break;
            }
          }
        }
        if (!passOk) {
          return send(socket, { type: "connect-result", ok: false, error: "Wrong access password." });
        }

        // Locate active target socket
        let targetSocket = socketsByPublicId.get(targetId);
        if (!targetSocket || targetSocket.readyState !== 1) {
          const ownerSockets = socketsByOwner.get(String(targetDev.ownerId));
          if (ownerSockets) {
            for (const s of ownerSockets) {
              if (s.readyState === 1 && s !== socket) {
                targetSocket = s;
                break;
              }
            }
          }
        }
        if (!targetSocket || targetSocket.readyState !== 1) {
          return send(socket, { type: "connect-result", ok: false, error: "The remote PC is not online." });
        }

        // Link peers both ways
        socket.peer = targetSocket;
        targetSocket.peer = socket;
        peers.set(key, targetSocket);
        peers.set(targetSocket._desklyKey, socket);

        const settings = await Settings.findOne({ userId: targetDev.ownerId });
        const owner = await User.findById(targetDev.ownerId).select("username");

        send(socket, {
          type: "connect-result",
          ok: true,
          device: { publicId: targetDev.publicId, username: owner?.username || "Unknown device" },
        });

        send(targetSocket, {
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
      sockets.delete(key);
      if (socketsByOwner.has(userId)) {
        socketsByOwner.get(userId).delete(socket);
        if (socketsByOwner.get(userId).size === 0) socketsByOwner.delete(userId);
      }
      if (clientPublicId && socketsByPublicId.get(clientPublicId) === socket) {
        socketsByPublicId.delete(clientPublicId);
      }

      const remaining = socketsByOwner.get(userId);
      if (remaining && remaining.size > 0) {
        const nextSocket = remaining.values().next().value;
        Device.find({ ownerId: userId }).then((devs) => {
          for (const dev of devs) {
            if (socketsByPublicId.get(dev.publicId) === socket) {
              socketsByPublicId.set(dev.publicId, nextSocket);
            }
          }
        }).catch(() => {});
      } else {
        setOnline(userId, role, false);
      }

      if (socket.peer) {
        const peerSocket = socket.peer;
        const peerKey = peerSocket._desklyKey;
        const timer = setTimeout(() => {
          goneTimers.delete(key);
          if (!sockets.has(key)) {
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
