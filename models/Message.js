const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    trim: true
  },
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  channel: {
    type: String,
    required: true,
    enum: ['general', 'trading', 'nft', 'defi', 'announcements'],
    default: 'general'
  },
  avatar: {
    type: String,
    default: null
  },
  isBroadcast: {
    type: Boolean,
    default: false
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster queries
messageSchema.index({ channel: 1, timestamp: -1 });
messageSchema.index({ userId: 1 });
messageSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Message', messageSchema);
