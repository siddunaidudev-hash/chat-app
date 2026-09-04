const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
  username: { type: String, required: true },
  text: { type: String, default: '' },
  fileUrl: { type: String, default: null },
  fileType: { type: String, default: null },
  backgroundColor: { type: String, default: '#111b21' },
  viewedBy: [{ type: String }],
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  }
}, { timestamps: true });

statusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Status', statusSchema);