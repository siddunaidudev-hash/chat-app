require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Database connected!'))
  .catch(err => console.log('DB Error:', err));

const messageSchema = new mongoose.Schema({
  sender: String,
  text: String,
  time: String,
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

io.on('connection', async (socket) => {
  console.log('Someone joined!');

  const oldMessages = await Message.find().sort({ createdAt: 1 }).limit(50);
  socket.emit('message_history', oldMessages);

  socket.on('send_message', async (data) => {
    const message = new Message({
      sender: data.sender,
      text: data.text,
      time: data.time
    });
    await message.save();
    io.emit('receive_message', data);
  });

  socket.on('disconnect', () => {
    console.log('Someone left');
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server is running! Open: http://localhost:3000');
});