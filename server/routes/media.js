const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { uploadToSupabase } = require('../supabase');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const ext = path.extname(req.file.originalname) || '.bin';
    const filename = `media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    const fileUrl = await uploadToSupabase(req.file.buffer, filename, req.file.mimetype);
    const mime = req.file.mimetype;
    let fileType = 'document';
    if (mime.startsWith('image/')) fileType = 'image';
    else if (mime.startsWith('video/')) fileType = 'video';
    else if (mime.startsWith('audio/')) fileType = 'voice';
    res.json({ fileUrl, fileType, fileName: req.file.originalname });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;