require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const passport = require('passport');
const session = require('express-session');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const groupRoutes = require('./routes/groups');
const uploadRoutes = require('./routes/upload');
const mediaRoutes = require('./routes/media');
const statusRoutes = require('./routes/status');
const Message = require('./models/Message');
const GroupMessage = require('./models/GroupMessage');
const User = require('./models/User');
const Group = require('./models/Group');
const Status = require('./models/Status');

// ============ CRASH PREVENTION ============
process.on('uncaughtException', err => {
  console.error('Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (server kept alive):', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 5e6
});

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/status', statusRoutes);

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      const username = profile.displayName.replace(/\s+/g, '').toLowerCase() +
        Math.floor(Math.random() * 1000);
      user = new User({
        username, googleId: profile.id,
        email: profile.emails[0].value,
        password: 'google_oauth_' + profile.id
      });
      await user.save();
    }
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (e) { done(e, null); }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    try {
      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        { id: req.user._id, username: req.user.username },
        process.env.JWT_SECRET, { expiresIn: '7d' }
      );
      res.redirect(`/?token=${token}&username=${req.user.username}`);
    } catch (e) { res.redirect('/'); }
  }
);

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://chat-app-a33b.onrender.com</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

app.get('/ping', (req, res) => res.json({ status: 'alive' }));

app.get('/api/lastmessages/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const messages = await Message.aggregate([
      { $match: { $or: [{ sender: username }, { receiver: username }], deletedForEveryone: { $ne: true } } },
      { $addFields: { otherUser: { $cond: [{ $eq: ['$sender', username] }, '$receiver', '$sender'] } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$otherUser', lastText: { $first: '$text' }, lastTime: { $first: '$createdAt' }, lastSender: { $first: '$sender' }, fileType: { $first: '$fileType' } } }
    ]);
    res.json(messages);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const messages = await Message.find({
      $or: [{ sender: user1, receiver: user2 }, { sender: user2, receiver: user1 }]
    }).sort({ createdAt: 1 }).limit(100);
    res.json(messages);
  } catch (err) { res.status(500).json([]); }
});

app.delete('/api/messages/:id', async (req, res) => {
  try {
    const { username, deleteType } = req.body;
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ success: false });
    if (msg.sender !== username) return res.status(403).json({ success: false });
    if (deleteType === 'everyone') {
      msg.deletedForEveryone = true;
      msg.text = 'This message was deleted';
      await msg.save();
      io.emit('message_deleted_everyone', { messageId: req.params.id });
    } else {
      if (!msg.deletedFor.includes(username)) { msg.deletedFor.push(username); await msg.save(); }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/clearchat/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const { username } = req.body;
    await Message.updateMany(
      { $or: [{ sender: user1, receiver: user2 }, { sender: user2, receiver: user1 }] },
      { $addToSet: { deletedFor: username } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/auth/delete-account', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false });
    await User.deleteOne({ username });
    await Message.deleteMany({ $or: [{ sender: username }, { receiver: username }] });
    await GroupMessage.deleteMany({ sender: username });
    await Group.updateMany({ members: username }, { $pull: { members: username } }).catch(() => {});
    await Status.deleteMany({ username }).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('Database connected!'))
  .catch(err => console.log('DB Error:', err));

const RENDER_URL = process.env.RENDER_URL || null;
if (RENDER_URL) {
  setInterval(() => {
    fetch(RENDER_URL + '/ping').catch(() => {});
  }, 10 * 60 * 1000);
}

const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
  });

  socket.on('set_username', async (username) => {
    try {
      if (!username) return;
      socket.username = username;
      onlineUsers[username] = socket.id;
      socket.join(username);
      io.emit('online_users', Object.keys(onlineUsers));

      // Deliver pending messages in one batch
      const pendingMsgs = await Message.find({
        receiver: username, status: 'sent', deletedForEveryone: { $ne: true }
      }).limit(50);

      if (pendingMsgs.length > 0) {
        const msgIds = pendingMsgs.map(m => m._id);
        await Message.updateMany({ _id: { $in: msgIds } }, { $set: { status: 'delivered' } });
        const senderGroups = {};
        pendingMsgs.forEach(msg => {
          if (!senderGroups[msg.sender]) senderGroups[msg.sender] = [];
          senderGroups[msg.sender].push(msg._id.toString());
        });
        for (const [sender, ids] of Object.entries(senderGroups)) {
          const senderSocket = onlineUsers[sender];
          if (senderSocket) {
            ids.forEach(id => io.to(senderSocket).emit('message_delivered', { messageId: id }));
          }
        }
      }
    } catch (e) { console.error('set_username error:', e.message); }
  });

  socket.on('mark_read', async ({ chatPartner }) => {
    try {
      const reader = socket.username;
      if (!reader || !chatPartner) return;

      // One DB call instead of loop
      const msgs = await Message.find({
        sender: chatPartner, receiver: reader,
        status: { $ne: 'read' }, deletedForEveryone: { $ne: true }
      }).select('_id').limit(100);

      if (msgs.length === 0) return;

      const msgIds = msgs.map(m => m._id);
      await Message.updateMany({ _id: { $in: msgIds } }, { $set: { status: 'read' } });

      const senderSocket = onlineUsers[chatPartner];
      if (senderSocket) {
        io.to(senderSocket).emit('messages_read', {
          messageIds: msgIds.map(id => id.toString())
        });
      }
    } catch (e) { console.error('mark_read error:', e.message); }
  });

  socket.on('private_message', async ({ receiver, text, fileUrl, fileType, fileName, replyTo, disappearSeconds }) => {
    try {
      const sender = socket.username;
      if (!sender || !receiver) return;

      const receiverUser = await User.findOne({ username: receiver }).select('blockedUsers').lean();
      if (receiverUser?.blockedUsers?.includes(sender)) {
        socket.emit('message_blocked', { receiver });
        return;
      }

      const receiverOnline = !!onlineUsers[receiver];
      const disappearsAt = disappearSeconds ? new Date(Date.now() + disappearSeconds * 1000) : null;

      const msg = new Message({
        sender, receiver,
        text: text || '',
        fileUrl: fileUrl || null,
        fileType: fileType || null,
        fileName: fileName || null,
        replyTo: replyTo || null,
        status: receiverOnline ? 'delivered' : 'sent',
        disappearsAt
      });
      await msg.save();

      const msgId = msg._id.toString();
      const msgData = {
        sender, text: text || '', fileUrl, fileType, fileName,
        replyTo: replyTo || null,
        time: new Date().toLocaleTimeString(),
        msgId, disappearsAt: disappearsAt || null
      };

      io.to(receiver).emit('receive_private', msgData);
      socket.emit('message_saved', { msgId, status: msg.status });
    } catch (e) { console.error('private_message error:', e.message); }
  });

  socket.on('join_group', (groupId) => {
    try { socket.join(groupId); } catch (e) {}
  });

  socket.on('group_message', async ({ groupId, text, fileUrl, fileType, fileName, replyTo, disappearSeconds }) => {
    try {
      const sender = socket.username;
      if (!sender || !groupId) return;
      const disappearsAt = disappearSeconds ? new Date(Date.now() + disappearSeconds * 1000) : null;
      const msg = new GroupMessage({ groupId, sender, text: text || '', disappearsAt });
      await msg.save();
      io.to(groupId).emit('receive_group_message', {
        sender, text: text || '', fileUrl, fileType, fileName,
        replyTo: replyTo || null,
        time: new Date().toLocaleTimeString(),
        disappearsAt: disappearsAt || null
      });
    } catch (e) { console.error('group_message error:', e.message); }
  });

  // ============ CALL SIGNALING ============
  socket.on('call_offer', ({ to, offer, callType }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('incoming_call', { from: socket.username, offer, callType });
    } catch (e) {}
  });

  socket.on('call_answer', ({ to, answer }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('call_answered', { answer });
    } catch (e) {}
  });

  socket.on('call_reject', ({ to }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('call_rejected');
    } catch (e) {}
  });

  socket.on('call_end', ({ to }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('call_ended');
    } catch (e) {}
  });

  socket.on('ice_candidate', ({ to, candidate }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('ice_candidate', { candidate });
    } catch (e) {}
  });

  // ============ GROUP CALLS ============
  socket.on('group_call_join', ({ groupId, callType }) => {
    try {
      socket.join(`call_${groupId}`);
      socket.to(`call_${groupId}`).emit('group_call_user_joined', { username: socket.username, callType });
    } catch (e) {}
  });

  socket.on('group_call_offer', ({ to, offer }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('group_call_offer', { from: socket.username, offer });
    } catch (e) {}
  });

  socket.on('group_call_answer', ({ to, answer }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('group_call_answer', { from: socket.username, answer });
    } catch (e) {}
  });

  socket.on('group_ice_candidate', ({ to, candidate }) => {
    try {
      const toSocket = onlineUsers[to];
      if (toSocket) io.to(toSocket).emit('group_ice_candidate', { from: socket.username, candidate });
    } catch (e) {}
  });

  socket.on('group_call_leave', ({ groupId }) => {
    try {
      socket.leave(`call_${groupId}`);
      socket.to(`call_${groupId}`).emit('group_call_user_left', { username: socket.username });
    } catch (e) {}
  });

  socket.on('disconnect', () => {
    try {
      if (socket.username) {
        delete onlineUsers[socket.username];
        io.emit('online_users', Object.keys(onlineUsers));
      }
    } catch (e) {}
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});