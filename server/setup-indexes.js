require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected to database...');
  const db = mongoose.connection.db;

  // Make message loading faster
  await db.collection('messages').createIndex(
    { sender: 1, receiver: 1, createdAt: -1 }
  );
  await db.collection('messages').createIndex(
    { receiver: 1, status: 1 }
  );
  await db.collection('messages').createIndex(
    { createdAt: -1 }
  );

  // Make user search faster
  await db.collection('users').createIndex(
    { username: 1 }, { unique: true }
  );

  // Make group loading faster
  await db.collection('groups').createIndex(
    { members: 1 }
  );

  // Make status loading faster
  await db.collection('statuses').createIndex(
    { username: 1, createdAt: -1 }
  );
  await db.collection('statuses').createIndex(
    { expiresAt: 1 }, { expireAfterSeconds: 0 }
  );

  console.log('All indexes created! App will now be faster.');
  process.exit(0);
}).catch(err => {
  console.log('Error:', err.message);
  process.exit(1);
});