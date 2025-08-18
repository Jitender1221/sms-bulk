const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema({
  accountId: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ["initialized", "authenticated", "ready", "disconnected"],
    default: "initialized",
  },
  lastActivity: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Account", accountSchema);
