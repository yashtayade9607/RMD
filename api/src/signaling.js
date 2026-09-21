import bcrypt from "bcryptjs";
import { Device, Settings, User } from "./models.js";
import { verifyToken } from "./auth.js";

// Signaling: WebRTC carries screen and controls directly between PCs.
export function attachSignaling(app) {
  const sockets = new Map();      // socketKey -> socket
  const userSockets = new Map();  // userId -> Set<socket>
  const peers = new Map();        // socketKey -> peer socket
  const goneTimers = new Map();   // socketKey -> setTimeout handle
  const GONE_GRACE_MS = 8000;     // 8s grace window for reconnects

  const socketKey = (userId, role) => `${userId}:${role}`;

  function send(socket, payload) {
    if (socket && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    }
  }

  async function broadcastPresence(userId) {
    try {
      const user = await User.findById(userId).select("username");
      const devices = await Device.find({ ownerId: userId }).select("publicId role online");
      for (const d of devices) {
        const payload = {
          type: "presence",
          userId: String(userId),
          username: user?.username || "",
          publicId: d.publicId,
          role: d.role,
          online: !!d.online,
        };
        for (const s of sockets.values()) {
          send(s, payload);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function updateDevicePresence(userId) {
    const userSet = userSockets.get(String(userId));
    let isHostOnline = false;
    let isControllerOnline = false;
    if (userSet && userSet.size > 0) {
      for (const s of userSet) {
        if (s.readyState === 1) {
          if (s._desklyRole === "host") isHostOnline = true;
          if (s._desklyRole === "controller") isControllerOnline = true;
        }
      }
    }
    await Device.updateOne(
      { ownerId: userId, role: "host" },
      { $set: { online: isHostOnline, lastSeenAt: new Date() } }
    );
    await Device.updateOne(
      { ownerId: userId, role: "controller" },
      { $set: { online: isControllerOnline, lastSeenAt: new Date() } }
    );
    await broadcastPresence(userId);
  }

  app.get("/ws", { websocket: true }, async (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const token = url.searchParams.get("token");
    const roleParam = url.searchParams.get("role") || "controller";
    const role = (roleParam === "host" || roleParam === "controller") ? roleParam : "controller";

    let user;
    try {
      user = verifyToken(token || "");
    } catch {
      socket.close(4001, "auth");
      return;
    }

    const key = socketKey(user.sub, role);

    // Cancel pending peer-gone timer if reconnecting within grace window
    if (goneTimers.has(key)) {
      clearTimeout(goneTimers.get(key));
      goneTimers.delete(key);
    }

    // Close any previous socket for this specific key
    const previous = sockets.get(key);
    if (previous && previous !== socket) {
      try { previous.close(4000, "replaced"); } catch { /* ignore */ }
    }
    sockets.set(key, socket);

    // Add to user socket set
    if (!userSockets.has(user.sub)) {
      userSockets.set(user.sub, new Set());
    }
    userSockets.get(user.sub).add(socket);

    // Re-attach to existing peer session if one exists
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
    socket._desklyUserId = user.sub;
    socket._desklyRole = role;

    await updateDevicePresence(user.sub);
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

      // Mode-agnostic connection: any connected device can initiate connection to any other device
      if (msg.type === "connect") {
        const targetId = String(msg.hostId || msg.targetId || "").replace(/\D/g, "");
        const targetDevice = await Device.findOne({ publicId: targetId });
        if (!targetDevice) {
          return send(socket, { type: "connect-result", ok: false, error: "Unknown device ID." });
        }

        const hostDevice = await Device.findOne({ ownerId: targetDevice.ownerId, role: "host" });
        const pwdToTest = String(msg.password || "");
        let pwOk = false;
        if (targetDevice.accessPasswordPlain && pwdToTest === targetDevice.accessPasswordPlain) {
          pwOk = true;
        } else if (targetDevice.accessPasswordHash && (await bcrypt.compare(pwdToTest, targetDevice.accessPasswordHash))) {
          pwOk = true;
        } else if (hostDevice && hostDevice.accessPasswordPlain && pwdToTest === hostDevice.accessPasswordPlain) {
          pwOk = true;
        } else if (hostDevice && hostDevice.accessPasswordHash && (await bcrypt.compare(pwdToTest, hostDevice.accessPasswordHash))) {
          pwOk = true;
        }

        if (!pwOk) {
          return send(socket, { type: "connect-result", ok: false, error: "Wrong access password." });
        }

        // Find active socket for target owner (prefer host role if available)
        const targetUserSocketSet = userSockets.get(String(targetDevice.ownerId));
        let targetSocket = null;
        if (targetUserSocketSet && targetUserSocketSet.size > 0) {
          for (const s of targetUserSocketSet) {
            if (s.readyState === 1) {
              if (s._desklyRole === "host") {
                targetSocket = s;
                break;
              }
              targetSocket = s;
            }
          }
        }

        if (!targetSocket || targetSocket.readyState !== 1) {
          return send(socket, { type: "connect-result", ok: false, error: "The controlled PC is not online." });
        }

        if (targetSocket === socket) {
          return send(socket, { type: "connect-result", ok: false, error: "Cannot connect to the same device instance." });
        }

        // Pair caller (controller) with target (host)
        socket.peer = targetSocket;
        targetSocket.peer = socket;
        peers.set(key, targetSocket);
        peers.set(targetSocket._desklyKey, socket);

        const settings = await Settings.findOne({ userId: targetDevice.ownerId });
        const owner = await User.findById(targetDevice.ownerId).select("username");
        const callerOwner = await User.findById(user.sub).select("username");

        send(socket, {
          type: "connect-result",
          ok: true,
          device: {
            publicId: targetDevice.publicId,
            username: owner?.username || "Unknown device",
          },
        });

        send(targetSocket, {
          type: "start-session",
          caller: {
            userId: user.sub,
            username: callerOwner?.username || "Controller",
          },
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

    socket.on("close", async () => {
      if (sockets.get(key) === socket) sockets.delete(key);

      const userSet = userSockets.get(user.sub);
      if (userSet) {
        userSet.delete(socket);
        if (userSet.size === 0) {
          userSockets.delete(user.sub);
        }
      }
      await updateDevicePresence(user.sub);

      if (socket.peer) {
        const peerSocket = socket.peer;
        const peerKey = peerSocket._desklyKey;
        const timer = setTimeout(() => {
          goneTimers.delete(key);
          if (sockets.get(key) !== socket && !sockets.has(key)) {
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
