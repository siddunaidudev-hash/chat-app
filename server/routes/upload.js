const express = require('express');
const router = express.Router();
const multer = require('multer');
const User = require('../models/User');
const { uploadToSupabase } = require('../supabase');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

router.post('/', upload.single('profilePic'), async (req, res) => {
  try {
    const { username } = req.body;
    if (!req.file || !username) return res.status(400).json({ error: 'Missing data' });
    const filename = `avatar_${username}.jpg`;
    const profilePic = await uploadToSupabase(req.file.buffer, filename, req.file.mimetype);
    await User.findOneAndUpdate({ username }, { profilePic });
    res.json({ profilePic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username }).select('profilePic');
    res.json({ profilePic: user?.profilePic || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;