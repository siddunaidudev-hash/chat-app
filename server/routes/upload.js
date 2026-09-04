const express = require('express');
const multer = require('multer');
const path = require('path');
const User = require('../models/User');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../public/uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.body.username + '_' + Date.now() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  }
});

router.post('/', upload.single('profilePic'), async (req, res) => {
  try {
    const { username } = req.body;
    const picPath = '/uploads/' + req.file.filename;
    await User.findOneAndUpdate({ username }, { profilePic: picPath });
    res.json({ profilePic: picPath });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    res.json({ profilePic: user?.profilePic || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;