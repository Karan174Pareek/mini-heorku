const mongoose = require('mongoose');

const ReleaseSchema = new mongoose.Schema({
  appSlug: {
    type: String,
    required: true,
    index: true,
  },
  commitSha: {
    type: String,
    required: true,
    index: true,
  },
  shortSha: {
    type: String,
    required: true,
  },
  ref: {
    type: String,
    default: 'refs/heads/main',
  },
  status: {
    type: String,
    enum: ['queued', 'building', 'succeeded', 'failed'],
    default: 'queued',
    index: true,
  },
  strategy: {
    type: String,
    enum: ['dockerfile', 'buildpack'],
    required: true,
  },
  image: {
    type: String,
    default: null,
  },
  digest: {
    type: String,
    default: null,
  },
  buildLog: {
    type: String,
    default: '',
  },
  startedAt: {
    type: Date,
    default: null,
  },
  finishedAt: {
    type: Date,
    default: null,
  },
  error: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.models.Release || mongoose.model('Release', ReleaseSchema);
