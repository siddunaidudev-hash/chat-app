const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  receiver: { type: String, required: true },
  text: { type: String, default: '' },
  fileUrl: { type: String, default: null },
  fileType: { type: String, default: null },
  fileName: { type: String, default: null },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  replyTo: {
    text: { type: String, default: null },
    sender: { type: String, default: null },
    fileType: { type: String, default: null }
  },
  disappearsAt: { type: Date, default: null },
  noForward: { type: Boolean, default: false },
  deletedFor: [{ type: String }],
  deletedForEveryone: { type: Boolean, default: false }
}, { timestamps: true });

messageSchema.index({ disappearsAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Message', messageSchema);