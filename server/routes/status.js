const express = require('express');
const multer = require('multer');
const path = require('path');
const Status = require('../models/Status');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../public/uploads'));
  },
  filename: (req, file, cb) => {
    cb(null, 'status_' + Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { username, text, backgroundColor } = req.body;
    const fileUrl = req.file ? '/uploads/' + req.file.filename : null;
    const fileType = req.file
      ? (req.file.mimetype.startsWith('image/') ? 'image'
        : req.file.mimetype.startsWith('video/') ? 'video' : 'document')
      : null;
    const status = new Status({ username, text, fileUrl, fileType, backgroundColor });
    await status.save();
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/all/:username', async (req, res) => {
  try {
    const now = new Date();
    const statuses = await Status.find({
      username: { $ne: req.params.username },
      expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });
    const grouped = {};
    statuses.forEach(s => {
      if (!grouped[s.username]) grouped[s.username] = [];
      grouped[s.username].push(s);
    });
    res.json(grouped);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/mine/:username', async (req, res) => {
  try {
    const statuses = await Status.find({
      username: req.params.username,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/view/:statusId', async (req, res) => {
  try {
    const { username } = req.body;
    await Status.findByIdAndUpdate(req.params.statusId, {
      $addToSet: { viewedBy: username }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:statusId', async (req, res) => {
  try {
    await Status.findByIdAndDelete(req.params.statusId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;