const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  accountId: { type: String, required: true },
  phone: { type: String, required: true },
  message: String,
  media: {
    url: String,
    caption: String,
  },
  status: {
    type: String,
    enum: ["sent", "failed", "delivered"],
    default: "sent",
  },
  error: String,
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Message", messageSchema);
