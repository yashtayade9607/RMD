import bcrypt from "bcryptjs";
import { Device, Settings, User } from "./models.js";
import { requireAuth, signToken } from "./auth.js";

function randomDigits(n) {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function formatId(id) {
  return `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6, 9)}`;
}

async function uniquePublicId() {
  for (let i = 0; i < 20; i++) {
    const id = randomDigits(9);
    const exists = await Device.findOne({ publicId: id });
    if (!exists) return id;
  }
  throw new Error("Could not allocate a device ID");
}

export function publicDevice(device, accessPasswordPlain) {
  const plain = accessPasswordPlain || device.accessPasswordPlain || "";
  const dto = {
    id: String(device._id),
    role: device.role,
    publicId: device.publicId,
    publicIdDisplay: formatId(device.publicId),
    displayName: device.displayName,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
  };
  if (plain) dto.accessPassword = plain;
  return dto;
}

export async function populateRecentDevices(recentDevices = []) {
  if (!Array.isArray(recentDevices) || !recentDevices.length) return [];
  const populated = await Promise.all(
    recentDevices.map(async (item) => {
      const pubId = String(item.publicId || "").replace(/\D/g, "");
      const dev = await Device.findOne({ publicId: pubId });
      let username = item.username || "Unknown device";
      let online = false;
      if (dev) {
        online = !!dev.online;
        const owner = await User.findById(dev.ownerId).select("username");
        if (owner && owner.username) {
          username = owner.username;
        }
      }
      return {
        publicId: pubId,
        username,
        accessPassword: String(item.accessPassword || ""),
        online,
        lastConnectedAt: item.lastConnectedAt,
      };
    })
  );
  return populated;
}

export async function registerRoutes(app) {
  app.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

  app.get("/api/bootstrap", async (request, reply) => {
    try {
      const count = await User.countDocuments();
      return { needsSetup: count === 0 };
    } catch (err) {
      return reply.code(503).send({ error: "Database unavailable. Please restart the API server." });
    }
  });

  const createAccount = async (request, reply) => {
    const { username, password } = request.body || {};
    const name = String(username || "").trim().toLowerCase();
    const pass = String(password || "");
    if (name.length < 3 || pass.length < 4) {
      return reply.code(400).send({ error: "Pick a username (3+ characters) and password (4+)." });
    }

    try {
      // Check for duplicate username before creating
      const exists = await User.findOne({ username: name });
      if (exists) return reply.code(400).send({ error: "Username is already taken." });

      const user = await User.create({
        username: name,
        passwordHash: await bcrypt.hash(pass, 10),
      });

      const hostPassword = randomPassword();
      const controllerPassword = randomPassword();
      const host = await Device.create({
        ownerId: user._id,
        role: "host",
        publicId: await uniquePublicId(),
        accessPasswordHash: await bcrypt.hash(hostPassword, 10),
        accessPasswordPlain: hostPassword,
        displayName: "This PC (controlled)",
      });
      const controller = await Device.create({
        ownerId: user._id,
        role: "controller",
        publicId: await uniquePublicId(),
        accessPasswordHash: await bcrypt.hash(controllerPassword, 10),
        accessPasswordPlain: controllerPassword,
        displayName: "This PC (controller)",
      });
      const settings = await Settings.create({
        userId: user._id,
        mouseFollow: true,
        blockWinKey: true,
        videoQuality: "balanced",
        screenSize: "adaptive",
        hostRunInBackground: false,
        fps: 60,
        recentDevices: [],
      });

      const token = signToken(String(user._id), user.username);
      return {
        token,
        user: { id: String(user._id), username: user.username },
        settings: settings.toObject(),
        devices: {
          host: publicDevice(host, hostPassword),
          controller: publicDevice(controller, controllerPassword),
        },
        note: "Save the host ID and password. The controller uses them to connect. There is no accept prompt.",
      };
    } catch (err) {
      if (err.code === 11000) {
        return reply.code(400).send({ error: "Username is already taken." });
      }
      throw err; // let global error handler deal with it
    }
  };

  // setup is kept for older installs; register is the normal create-account endpoint.
  app.post("/api/setup", createAccount);
  app.post("/api/register", createAccount);

  app.post("/api/login", async (request, reply) => {
    try {
      const { username, password } = request.body || {};
      if (!username || !password) {
        return reply.code(400).send({ error: "Username and password are required." });
      }
      const user = await User.findOne({ username: String(username || "").trim().toLowerCase() });
      if (!user || !(await bcrypt.compare(String(password || ""), user.passwordHash))) {
        return reply.code(401).send({ error: "Wrong username or password." });
      }
      const token = signToken(String(user._id), user.username);
      const settings = await Settings.findOne({ userId: user._id });
      const settingsObj = settings ? settings.toObject() : {};
      if (settingsObj.recentDevices) {
        settingsObj.recentDevices = await populateRecentDevices(settingsObj.recentDevices);
      }
      const host = await Device.findOne({ ownerId: user._id, role: "host" });
      const controller = await Device.findOne({ ownerId: user._id, role: "controller" });
      return {
        token,
        user: { id: String(user._id), username: user.username },
        settings: settingsObj,
        devices: {
          host: host ? publicDevice(host) : null,
          controller: controller ? publicDevice(controller) : null,
        },
      };
    } catch (err) {
      throw err;
    }
  });

  app.get("/api/me", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const user = await User.findById(request.user.sub);
      if (!user) return reply.code(401).send({ error: "User account not found. Please log in again." });
      const settings = await Settings.findOne({ userId: user._id });
      const settingsObj = settings ? settings.toObject() : {};
      if (settingsObj.recentDevices) {
        settingsObj.recentDevices = await populateRecentDevices(settingsObj.recentDevices);
      }
      const host = await Device.findOne({ ownerId: user._id, role: "host" });
      const controller = await Device.findOne({ ownerId: user._id, role: "controller" });
      return {
        user: { id: String(user._id), username: user.username },
        settings: settingsObj,
        devices: {
          host: host ? publicDevice(host) : null,
          controller: controller ? publicDevice(controller) : null,
        },
      };
    } catch (err) {
      throw err;
    }
  });

  app.get("/api/devices/status", { preHandler: requireAuth }, async (request) => {
    const settings = await Settings.findOne({ userId: request.user.sub });
    const recent = settings?.recentDevices || [];
    const populated = await populateRecentDevices(recent);
    return { recentDevices: populated };
  });

  app.patch("/api/settings", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const patch = request.body || {};
      const allowed = {};
      if (typeof patch.mouseFollow === "boolean") allowed.mouseFollow = patch.mouseFollow;
      if (typeof patch.blockWinKey === "boolean") allowed.blockWinKey = patch.blockWinKey;
      if (["smooth", "balanced", "sharp"].includes(patch.videoQuality)) {
        allowed.videoQuality = patch.videoQuality;
      }
      if (["adaptive", "720p", "1080p"].includes(patch.screenSize)) {
        allowed.screenSize = patch.screenSize;
      }
      if (typeof patch.hostRunInBackground === "boolean") {
        allowed.hostRunInBackground = patch.hostRunInBackground;
      }
      if (typeof patch.fps === "number" && patch.fps >= 15 && patch.fps <= 120) {
        allowed.fps = Math.round(patch.fps);
      }
      if (Array.isArray(patch.recentDevices)) {
        allowed.recentDevices = patch.recentDevices
          .filter((item) => /^\d{9}$/.test(String(item?.publicId || "").replace(/\D/g, "")))
          .slice(0, 16)
          .map((item) => ({
            publicId: String(item.publicId).replace(/\D/g, ""),
            username: String(item.username || "Unknown device").slice(0, 80),
            accessPassword: String(item.accessPassword || ""),
            lastConnectedAt: new Date(item.lastConnectedAt || Date.now()),
          }));
      }
      // upsert: create settings doc if it doesn't exist yet
      const settings = await Settings.findOneAndUpdate(
        { userId: request.user.sub },
        { $set: allowed },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      if (!settings) return reply.code(404).send({ error: "Settings not found." });
      const settingsObj = settings.toObject();
      settingsObj.recentDevices = await populateRecentDevices(settingsObj.recentDevices || []);
      return { settings: settingsObj };
    } catch (err) {
      throw err;
    }
  });

  app.delete("/api/settings/recent-devices/:publicId", { preHandler: requireAuth }, async (request) => {
    const targetId = String(request.params.publicId || "").replace(/\D/g, "");
    const settings = await Settings.findOne({ userId: request.user.sub });
    if (settings) {
      settings.recentDevices = settings.recentDevices.filter((item) => item.publicId !== targetId);
      await settings.save();
      const settingsObj = settings.toObject();
      settingsObj.recentDevices = await populateRecentDevices(settingsObj.recentDevices);
      return { ok: true, settings: settingsObj };
    }
    return { ok: true, settings: null };
  });

  const updateAccessPassword = async (request, reply) => {
    const host = await Device.findOne({ ownerId: request.user.sub, role: "host" });
    if (!host) return reply.code(404).send({ error: "Host device not found." });
    const requested = String(request.body?.accessPassword || "").trim();
    if (requested && requested.length < 4) {
      return reply.code(400).send({ error: "Access password must have at least 4 characters." });
    }
    const accessPassword = requested || randomPassword();
    host.accessPasswordHash = await bcrypt.hash(accessPassword, 10);
    host.accessPasswordPlain = accessPassword;
    await host.save();
    return { device: publicDevice(host, accessPassword) };
  };

  app.post("/api/devices/host/rotate-password", { preHandler: requireAuth }, updateAccessPassword);
  app.post("/api/devices/host/change-access-password", { preHandler: requireAuth }, updateAccessPassword);

  app.post("/api/account/change-password", { preHandler: requireAuth }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    const user = await User.findById(request.user.sub);
    if (!user || !(await bcrypt.compare(String(currentPassword || ""), user.passwordHash))) {
      return reply.code(400).send({ error: "Your current password is incorrect." });
    }
    if (String(newPassword || "").length < 4) {
      return reply.code(400).send({ error: "Your new password must have at least 4 characters." });
    }
    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    return { ok: true };
  });

  app.patch("/api/account/username", { preHandler: requireAuth }, async (request, reply) => {
    const newUsername = String(request.body?.username || "").trim().toLowerCase();
    if (newUsername.length < 3) {
      return reply.code(400).send({ error: "Username must be at least 3 characters." });
    }
    const existing = await User.findOne({ username: newUsername, _id: { $ne: request.user.sub } });
    if (existing) {
      return reply.code(400).send({ error: "Username is already taken." });
    }
    const user = await User.findById(request.user.sub);
    if (!user) return reply.code(404).send({ error: "User not found." });
    user.username = newUsername;
    await user.save();
    return { ok: true, user: { id: String(user._id), username: user.username } };
  });
}

export { formatId };
