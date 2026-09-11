import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

const deviceSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["host", "controller"], required: true },
    publicId: { type: String, required: true, unique: true },
    accessPasswordHash: { type: String, required: true },
    accessPasswordPlain: { type: String, default: "" },
    displayName: { type: String, default: "" },
    lastSeenAt: { type: Date, default: Date.now },
    online: { type: Boolean, default: false },
  },
  { timestamps: true }
);

deviceSchema.index({ ownerId: 1, role: 1 }, { unique: true });

const settingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    mouseFollow: { type: Boolean, default: true },
    blockWinKey: { type: Boolean, default: true },
    videoQuality: { type: String, enum: ["smooth", "balanced", "sharp"], default: "balanced" },
    screenSize: { type: String, enum: ["adaptive", "720p", "1080p"], default: "adaptive" },
    hostRunInBackground: { type: Boolean, default: false },
    recentDevices: {
      type: [{ publicId: String, username: String, accessPassword: String, lastConnectedAt: Date }],
      default: [],
    },
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
export const Device = mongoose.model("Device", deviceSchema);
export const Settings = mongoose.model("Settings", settingsSchema);
