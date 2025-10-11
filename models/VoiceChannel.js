const mongoose = require('mongoose');

const voiceChannelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: 200
  },
  isActive: {
    type: Boolean,
    default: true
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  maxParticipants: {
    type: Number,
    default: 10
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index for faster queries
voiceChannelSchema.index({ name: 1 });
voiceChannelSchema.index({ isActive: 1 });
voiceChannelSchema.index({ participants: 1 });

// Virtual for participant count
voiceChannelSchema.virtual('participantCount').get(function() {
  return this.participants.length;
});

// Ensure virtual fields are serialized
voiceChannelSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('VoiceChannel', voiceChannelSchema);
