const mongoose = require('mongoose');

const AppSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: /^[a-z0-9-]+$/,
  },
  gitToken: {
    type: String,
    required: true,
  },
  currentRelease: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Release',
    default: null,
  },
  deployStatus: {
    type: String,
    enum: ['pending', 'deploying', 'deployed', 'failed'],
    default: 'pending',
  },
  deployedAt: {
    type: Date,
    default: null,
  },
  envVars: {
    type: Map,
    of: String,
    default: {},
  },
}, {
  timestamps: true,
});

module.exports = mongoose.models.App || mongoose.model('App', AppSchema);
