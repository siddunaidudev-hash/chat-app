const express = require('express');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const multer = require('multer');
const path = require('path');
const router = express.Router();

router.post('/create', async (req, res) => {
  try {
    const { name, members, createdBy } = req.body;
    const group = new Group({ name, members, createdBy });
    await group.save();
    res.json(group);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/my/:username', async (req, res) => {
  try {
    const groups = await Group.find({ members: req.params.username });
    res.json(groups);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/messages/:groupId', async (req, res) => {
  try {
    const messages = await GroupMessage.find({
      groupId: req.params.groupId
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    res.json(group);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id/exit', async (req, res) => {
  try {
    const { username } = req.body;
    await Group.findByIdAndUpdate(req.params.id, {
      $pull: { members: username }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:id/addmember', async (req, res) => {
  try {
    const { username } = req.body;
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ message: 'Group not found' });
    if (!group.members.includes(username)) {
      group.members.push(username);
      await group.save();
    }
    res.json({ success: true, members: group.members });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../public/uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'group_' + req.params.id + '_' + Date.now() + ext);
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

router.post('/:id/pic', upload.single('groupPic'), async (req, res) => {
  try {
    const picPath = '/uploads/' + req.file.filename;
    await Group.findByIdAndUpdate(req.params.id, { groupPic: picPath });
    res.json({ groupPic: picPath });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;