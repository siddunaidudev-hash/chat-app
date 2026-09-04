const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  publicKey: { type: String, default: null },
  encryptedPrivKey: { type: String, default: null },
  googleId: { type: String, default: null },
  email: { type: String, default: null },
  profilePic: { type: String, default: null },
  blockedUsers: [{ type: String }],
  bio: { type: String, default: '' },
  isVisible: { type: Boolean, default: false },
  visibilityExpiresAt: { type: Date, default: null },
  location: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    updatedAt: { type: Date, default: null }
  },
  ghostMode: { type: Boolean, default: false },
  privacy: {
    whoCanMessage: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
    whoCanCall: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
    whoCanAddToGroups: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
    showOnlineStatus: { type: Boolean, default: true },
    showReadReceipts: { type: Boolean, default: true },
    showLastSeen: { type: Boolean, default: true },
    allowNearbyDiscovery: { type: Boolean, default: true },
    allowForwarding: { type: Boolean, default: true }
  },
  chatThemes: { type: Map, of: String, default: {} },
  preferredLanguage: { type: String, default: 'en' }
}, { timestamps: true });

userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  if (this.password.startsWith('google_oauth_')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);