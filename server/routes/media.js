const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../public/uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'media_' + Date.now() + ext);
  }
});

const getFileType = (mimetype) => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/', 'video/', 'audio/', 'application/', 'text/'];
    const ok = allowed.some(t => file.mimetype.startsWith(t));
    if (ok) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

router.post('/', upload.single('file'), (req, res) => {
  try {
    const fileUrl = '/uploads/' + req.file.filename;
    const fileType = getFileType(req.file.mimetype);
    res.json({ fileUrl, fileType, fileName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;