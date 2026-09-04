const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  members: [{ type: String }],
  createdBy: { type: String, required: true },
  groupPic: { type: String, default: null },
  description: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema);