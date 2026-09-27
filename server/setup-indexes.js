require('dotenv').config();
const mongoose = require('mongoose');
const Message = require('./models/Message');
const User = require('./models/User');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  await Message.collection.createIndex({ sender: 1, receiver: 1, createdAt: -1 });
  await Message.collection.createIndex({ receiver: 1, status: 1 });
  await User.collection.createIndex({ username: 1 }, { unique: true });
  console.log('Indexes created!');
  process.exit(0);
});