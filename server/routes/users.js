const express = require('express');
const User = require('../models/User');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const users = await User.find({}, 'username profilePic bio ghostMode');
    res.json(users.filter(u => !u.ghostMode));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/key/:username', async (req, res) => {
  try {
    await User.findOneAndUpdate({ username: req.params.username }, { publicKey: req.body.publicKey });
    res.json({ message: 'Key saved' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/key/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user || !user.publicKey) return res.status(404).json({ message: 'No key found' });
    res.json({ publicKey: user.publicKey });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/privkey/:username', async (req, res) => {
  try {
    await User.findOneAndUpdate({ username: req.params.username }, { encryptedPrivKey: req.body.privKey });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/privkey/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json({ privKey: user?.encryptedPrivKey || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/bio/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json({ bio: user?.bio || '' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/bio/:username', async (req, res) => {
  try {
    await User.findOneAndUpdate({ username: req.params.username }, { bio: req.body.bio });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Ghost Mode
router.post('/ghost', async (req, res) => {
  try {
    const { username, ghostMode } = req.body;
    await User.findOneAndUpdate({ username }, { ghostMode });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/ghost/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json({ ghostMode: user?.ghostMode || false });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Privacy Settings
router.get('/privacy/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json(user?.privacy || {});
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/privacy/:username', async (req, res) => {
  try {
    await User.findOneAndUpdate({ username: req.params.username }, { privacy: req.body });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Chat theme per conversation
router.post('/theme', async (req, res) => {
  try {
    const { username, chatKey, theme } = req.body;
    await User.findOneAndUpdate(
      { username },
      { $set: { [`chatThemes.${chatKey}`]: theme } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/theme/:username/:chatKey', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    const theme = user?.chatThemes?.get(req.params.chatKey) || 'default';
    res.json({ theme });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Language preference
router.post('/language', async (req, res) => {
  try {
    const { username, language } = req.body;
    await User.findOneAndUpdate({ username }, { preferredLanguage: language });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Visibility
router.post('/visibility', async (req, res) => {
  try {
    const { username, isVisible, lat, lng, durationMinutes } = req.body;
    const update = { isVisible };
    if (isVisible && lat && lng) {
      update.location = { lat, lng, updatedAt: new Date() };
      if (durationMinutes && durationMinutes > 0) {
        update.visibilityExpiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
      } else {
        update.visibilityExpiresAt = null;
      }
    } else {
      update.location = { lat: null, lng: null, updatedAt: null };
      update.visibilityExpiresAt = null;
    }
    await User.findOneAndUpdate({ username }, update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/visibility/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    let isVisible = user?.isVisible || false;
    if (isVisible && user.visibilityExpiresAt && new Date() > user.visibilityExpiresAt) {
      isVisible = false;
      await User.findOneAndUpdate({ username: req.params.username }, { isVisible: false });
    }
    res.json({ isVisible, expiresAt: user?.visibilityExpiresAt || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/nearby', async (req, res) => {
  try {
    const { username, lat, lng, radiusKm = 1 } = req.body;
    const visibleUsers = await User.find({
      username: { $ne: username },
      isVisible: true,
      ghostMode: { $ne: true },
      'privacy.allowNearbyDiscovery': { $ne: false },
      'location.lat': { $ne: null }
    }, 'username location bio profilePic visibilityExpiresAt');
    const now = new Date();
    const nearby = visibleUsers.filter(u => {
      if (u.visibilityExpiresAt && now > u.visibilityExpiresAt) return false;
      if (!u.location.lat || !u.location.lng) return false;
      const R = 6371;
      const dLat = (u.location.lat - lat) * Math.PI / 180;
      const dLng = (u.location.lng - lng) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 +
        Math.cos(lat * Math.PI/180) * Math.cos(u.location.lat * Math.PI/180) *
        Math.sin(dLng/2)**2;
      const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return dist <= radiusKm;
    });
    res.json(nearby.map(u => ({ username: u.username, bio: u.bio || '' })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/block', async (req, res) => {
  try {
    const { username, blockUsername } = req.body;
    await User.findOneAndUpdate({ username }, { $addToSet: { blockedUsers: blockUsername } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/block', async (req, res) => {
  try {
    const { username, blockUsername } = req.body;
    await User.findOneAndUpdate({ username }, { $pull: { blockedUsers: blockUsername } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/blocked/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json({ blocked: user?.blockedUsers || [] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;