const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pushr';

app.use(cors());
app.use(express.json());

// Routes
const releasesRouter = require('./routes/releases');
const internalRouter = require('./routes/internal');
const appsRouter = require('./routes/apps');

app.use('/api/releases', releasesRouter);
app.use('/api/internal/releases', internalRouter);
app.use('/api/apps', appsRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pushr-api',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

async function startServer() {
  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`Connected to MongoDB at ${mongoUri}`);
  } catch (err) {
    console.warn(`Warning: MongoDB connection failed (${err.message}). API will run with limited persistence.`);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Pushr Control Plane API listening on port ${port}`);
  });

  return { app, server };
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
