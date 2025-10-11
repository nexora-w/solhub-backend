require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/database');
const User = require('./models/User');
const Message = require('./models/Message');
const Channel = require('./models/Channel');
const VoiceChannel = require('./models/VoiceChannel');
const Role = require('./models/Role');

// Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active socket connections (for real-time features)
const activeConnections = new Map();
const channels = ['general', 'trading', 'nft', 'defi', 'announcements'];

// Initialize default channels
const initializeChannels = async () => {
  try {
    // Create a default user for system channels
    let systemUser = await User.findOne({ username: 'system' });
    if (!systemUser) {
      systemUser = new User({
        username: 'system',
        walletAddress: '0x0000000000000000000000000000000000000000',
        isOnline: false
      });
      await systemUser.save();
    }

    // Initialize text channels
    for (const channelName of channels) {
      const existingChannel = await Channel.findOne({ name: channelName });
      if (!existingChannel) {
        const channel = new Channel({
          name: channelName,
          description: `Default ${channelName} channel`,
          createdBy: systemUser._id
        });
        await channel.save();
        console.log(`Initialized channel: ${channelName}`);
      }
    }

    // Initialize default voice channels
    const defaultVoiceChannels = [
      { name: 'VOICE_CALL_#1*', description: 'General voice chat room' },
      { name: 'VOICE_CALL_#2*', description: 'Trading discussion voice room' },
      { name: 'VOICE_CALL_#3*', description: 'Community voice room' }
    ];

    for (const voiceChannelData of defaultVoiceChannels) {
      const existingVoiceChannel = await VoiceChannel.findOne({ name: voiceChannelData.name });
      if (!existingVoiceChannel) {
        const voiceChannel = new VoiceChannel({
          name: voiceChannelData.name,
          description: voiceChannelData.description,
          createdBy: systemUser._id
        });
        await voiceChannel.save();
        console.log(`Initialized voice channel: ${voiceChannelData.name}`);
      }
    }
  } catch (error) {
    console.error('Error initializing channels:', error);
  }
};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  console.log('Total connections:', io.engine.clientsCount);

  // Handle user joining
  socket.on('join', async (userData) => {
    try {
      // Check if userData is valid
      if (userData && userData.username && userData.walletAddress) {
        // Find or create user in database
        let user = await User.findOne({ 
          $or: [
            { username: userData.username },
            { walletAddress: userData.walletAddress }
          ]
        });

        if (!user) {
          // Create new user
          user = new User({
            username: userData.username,
            walletAddress: userData.walletAddress,
            avatar: userData.avatar || null,
            role: userData.role || 'user',
            isOnline: true,
            socketId: socket.id
          });
          await user.save();
        } else {
          // Update existing user
          user.isOnline = true;
          user.socketId = socket.id;
          user.lastSeen = new Date();
          if (userData.avatar) {
            user.avatar = userData.avatar;
          }
          if (userData.role) {
            user.role = userData.role;
          }
          await user.save();
        }

        // Store connection mapping
        activeConnections.set(socket.id, user._id);
        
        // Broadcast user joined
        socket.broadcast.emit('userJoined', {
          username: user.username,
          avatar: user.avatar,
          isOnline: true
        });
        
        console.log('User joined:', user.username);
        console.log('Total connected users:', activeConnections.size);
      } else if (userData === null) {
        // Handle wallet disconnection
        const userId = activeConnections.get(socket.id);
        if (userId) {
          const user = await User.findById(userId);
          if (user) {
            user.isOnline = false;
            user.socketId = null;
            await user.save();
            
            socket.broadcast.emit('userLeft', {
              username: user.username,
              avatar: user.avatar
            });
            
            activeConnections.delete(socket.id);
            console.log('User left:', user.username);
          }
        }
      }
    } catch (error) {
      console.error('Error handling join:', error);
      socket.emit('joinError', { error: 'Failed to join. Please try again.' });
    }
  });

  // Handle new messages
  socket.on('sendMessage', async (messageData) => {
    try {
      const userId = activeConnections.get(socket.id);
      if (!userId) {
        socket.emit('messageError', { error: 'User not found. Please reconnect.' });
        return;
      }

      const user = await User.findById(userId);
      if (!user || !user.isOnline) {
        socket.emit('messageError', { error: 'User not found. Please reconnect.' });
        return;
      }

      const message = new Message({
        username: user.username,
        text: messageData.text,
        channel: messageData.channel || 'general',
        avatar: user.avatar,
        userId: user._id,
        isBroadcast: false
      });

      await message.save();

      // Update channel's last message timestamp
      await Channel.findOneAndUpdate(
        { name: message.channel },
        { 
          lastMessageAt: message.timestamp,
          $inc: { messageCount: 1 }
        }
      );

      // Emit to all clients
      io.emit('newMessage', {
        id: message._id,
        username: message.username,
        text: message.text,
        timestamp: message.timestamp,
        avatar: message.avatar,
        channel: message.channel,
        isBroadcast: message.isBroadcast
      });

    } catch (error) {
      console.error('Error handling sendMessage:', error);
      socket.emit('messageError', { error: 'Server error processing message' });
    }
  });

  // Handle broadcast messages to all channels
  socket.on('broadcastMessage', async (messageData) => {
    try {
      const userId = activeConnections.get(socket.id);
      if (!userId) {
        socket.emit('messageError', { error: 'User not found. Please reconnect.' });
        return;
      }

      const user = await User.findById(userId);
      if (!user || !user.isOnline) {
        socket.emit('messageError', { error: 'User not found. Please reconnect.' });
        return;
      }

      const broadcastMessages = [];
      
      // Create a message for each channel
      for (const channelName of channels) {
        const message = new Message({
          username: user.username,
          text: messageData.text,
          channel: channelName,
          avatar: user.avatar,
          userId: user._id,
          isBroadcast: true
        });

        await message.save();

        // Update channel's last message timestamp
        await Channel.findOneAndUpdate(
          { name: channelName },
          { 
            lastMessageAt: message.timestamp,
            $inc: { messageCount: 1 }
          }
        );

        broadcastMessages.push({
          id: message._id,
          username: message.username,
          text: message.text,
          timestamp: message.timestamp,
          avatar: message.avatar,
          channel: message.channel,
          isBroadcast: message.isBroadcast
        });
      }
      
      // Emit all broadcast messages
      broadcastMessages.forEach(message => {
        io.emit('newMessage', message);
      });

    } catch (error) {
      console.error('Error handling broadcastMessage:', error);
      socket.emit('messageError', { error: 'Server error processing broadcast message' });
    }
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    const userId = activeConnections.get(socket.id);
    if (userId) {
      socket.broadcast.emit('userTyping', {
        userId: userId,
        isTyping: data.isTyping
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    try {
      const userId = activeConnections.get(socket.id);
      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          user.isOnline = false;
          user.socketId = null;
          await user.save();
          
          socket.broadcast.emit('userLeft', {
            username: user.username,
            avatar: user.avatar
          });
          
          console.log('User disconnected:', user.username);
        }
        activeConnections.delete(socket.id);
      } else {
        console.log('User disconnected without proper user data');
      }
      console.log('Total connected users:', activeConnections.size);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// API routes
app.get('/api/health', async (req, res) => {
  try {
    const onlineUsers = await User.countDocuments({ isOnline: true });
    const totalUsers = await User.countDocuments();
    const totalMessages = await Message.countDocuments();
    
    res.json({ 
      status: 'OK', 
      connectedUsers: activeConnections.size,
      onlineUsers: onlineUsers,
      totalUsers: totalUsers,
      totalMessages: totalMessages,
      totalConnections: io.engine.clientsCount,
      channels: channels,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const channel = req.query.channel || 'general';
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    
    const messages = await Message.find({ channel })
      .sort({ timestamp: -1 })
      .limit(limit)
      .skip(skip)
      .select('username text timestamp avatar channel isBroadcast');
    
    res.json(messages.reverse()); // Reverse to show oldest first
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/messages/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const allMessages = {};
    
    for (const channel of channels) {
      const messages = await Message.find({ channel })
        .sort({ timestamp: -1 })
        .limit(limit)
        .select('username text timestamp avatar channel isBroadcast');
      
      allMessages[channel] = messages.reverse();
    }
    
    res.json(allMessages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch all messages' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const onlineOnly = req.query.online === 'true';
    const query = onlineOnly ? { isOnline: true } : {};
    
    const users = await User.find(query)
      .select('username avatar isOnline lastSeen role joinedAt createdAt')
      .sort({ isOnline: -1, lastSeen: -1 });
    
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/channels', async (req, res) => {
  try {
    const channels = await Channel.find({ isActive: true })
      .populate('createdBy', 'username')
      .sort({ lastMessageAt: -1 });
    
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

app.get('/api/voice-channels', async (req, res) => {
  try {
    const voiceChannels = await VoiceChannel.find({ isActive: true })
      .populate('createdBy', 'username')
      .populate('participants', 'username avatar isOnline')
      .sort({ createdAt: 1 });
    
    res.json(voiceChannels);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch voice channels' });
  }
});

// Create new text channel
app.post('/api/channels', async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    // Check if channel already exists
    const existingChannel = await Channel.findOne({ name: name.toLowerCase() });
    if (existingChannel) {
      return res.status(400).json({ error: 'Channel already exists' });
    }

    // Find or create system user for admin-created channels
    let systemUser = await User.findOne({ username: 'system' });
    if (!systemUser) {
      systemUser = new User({
        username: 'system',
        walletAddress: '0x0000000000000000000000000000000000000000',
        isOnline: false
      });
      await systemUser.save();
    }

    const channel = new Channel({
      name: name.toLowerCase(),
      description: description || `Channel for ${name}`,
      createdBy: systemUser._id
    });

    await channel.save();
    
    // Populate the created channel
    const populatedChannel = await Channel.findById(channel._id)
      .populate('createdBy', 'username');

    res.status(201).json(populatedChannel);
  } catch (error) {
    console.error('Error creating channel:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Create new voice channel
app.post('/api/voice-channels', async (req, res) => {
  try {
    const { name, description, maxParticipants, isPrivate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Voice channel name is required' });
    }

    // Check if voice channel already exists
    const existingVoiceChannel = await VoiceChannel.findOne({ name });
    if (existingVoiceChannel) {
      return res.status(400).json({ error: 'Voice channel already exists' });
    }

    // Find or create system user for admin-created channels
    let systemUser = await User.findOne({ username: 'system' });
    if (!systemUser) {
      systemUser = new User({
        username: 'system',
        walletAddress: '0x0000000000000000000000000000000000000000',
        isOnline: false
      });
      await systemUser.save();
    }

    const voiceChannel = new VoiceChannel({
      name,
      description: description || `Voice channel for ${name}`,
      maxParticipants: maxParticipants || 10,
      isPrivate: isPrivate || false,
      createdBy: systemUser._id
    });

    await voiceChannel.save();
    
    // Populate the created voice channel
    const populatedVoiceChannel = await VoiceChannel.findById(voiceChannel._id)
      .populate('createdBy', 'username')
      .populate('participants', 'username avatar isOnline');

    res.status(201).json(populatedVoiceChannel);
  } catch (error) {
    console.error('Error creating voice channel:', error);
    res.status(500).json({ error: 'Failed to create voice channel' });
  }
});

// Get messages for a specific channel by channel ID
app.get('/api/channels/:id/messages', async (req, res) => {
  try {
    const channelId = req.params.id;
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    
    // First, find the channel to get its name
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    // Get messages for this channel
    const messages = await Message.find({ channel: channel.name })
      .populate('userId', 'username avatar')
      .sort({ timestamp: -1 })
      .limit(limit)
      .skip(skip)
      .select('username text timestamp avatar channel isBroadcast userId createdAt content');
    
    // Transform the messages to match the expected format
    const transformedMessages = messages.map(msg => ({
      _id: msg._id,
      content: msg.text || msg.content,
      username: msg.username,
      timestamp: msg.timestamp,
      avatar: msg.avatar,
      channel: msg.channel,
      isBroadcast: msg.isBroadcast,
      createdAt: msg.createdAt || msg.timestamp,
      user: {
        _id: msg.userId?._id,
        username: msg.userId?.username || msg.username,
        avatar: msg.userId?.avatar || msg.avatar
      }
    }));
    
    res.json(transformedMessages.reverse()); // Reverse to show oldest first
  } catch (error) {
    console.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

// Delete a specific message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    await Message.findByIdAndDelete(messageId);
    
    // Update channel's message count
    await Channel.findOneAndUpdate(
      { name: message.channel },
      { $inc: { messageCount: -1 } }
    );
    
    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Clear all messages in a channel
app.delete('/api/channels/:id/messages', async (req, res) => {
  try {
    const channelId = req.params.id;
    
    // First, find the channel to get its name
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    // Delete all messages in this channel
    const result = await Message.deleteMany({ channel: channel.name });
    
    // Reset channel's message count
    await Channel.findByIdAndUpdate(channelId, { messageCount: 0 });
    
    res.json({ 
      success: true, 
      message: `Successfully deleted ${result.deletedCount} messages`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error clearing channel messages:', error);
    res.status(500).json({ error: 'Failed to clear channel messages' });
  }
});

// Delete a text channel
app.delete('/api/channels/:id', async (req, res) => {
  try {
    const channelId = req.params.id;
    
    // Find the channel to get its name
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    
    // Delete all messages in this channel first
    const messageResult = await Message.deleteMany({ channel: channel.name });
    
    // Delete the channel
    await Channel.findByIdAndDelete(channelId);
    
    res.json({ 
      success: true, 
      message: `Successfully deleted channel "${channel.name}" and ${messageResult.deletedCount} messages`,
      deletedMessages: messageResult.deletedCount
    });
  } catch (error) {
    console.error('Error deleting channel:', error);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// Delete a voice channel
app.delete('/api/voice-channels/:id', async (req, res) => {
  try {
    const voiceChannelId = req.params.id;
    
    // Find the voice channel
    const voiceChannel = await VoiceChannel.findById(voiceChannelId);
    if (!voiceChannel) {
      return res.status(404).json({ error: 'Voice channel not found' });
    }
    
    // Delete the voice channel
    await VoiceChannel.findByIdAndDelete(voiceChannelId);
    
    res.json({ 
      success: true, 
      message: `Successfully deleted voice channel "${voiceChannel.name}"`
    });
  } catch (error) {
    console.error('Error deleting voice channel:', error);
    res.status(500).json({ error: 'Failed to delete voice channel' });
  }
});

// Role management API endpoints

// Get all roles
app.get('/api/roles', async (req, res) => {
  try {
    const roles = await Role.find()
      .sort({ createdAt: 1 });
    
    res.json(roles);
  } catch (error) {
    console.error('Error fetching roles:', error);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// Create new role
app.post('/api/roles', async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    // Check if role already exists
    const existingRole = await Role.findOne({ name: name.toLowerCase() });
    if (existingRole) {
      return res.status(400).json({ error: 'Role already exists' });
    }

    const role = new Role({
      name: name.toLowerCase(),
      description: description || `Role for ${name}`
    });

    await role.save();
    res.status(201).json(role);
  } catch (error) {
    console.error('Error creating role:', error);
    res.status(500).json({ error: 'Failed to create role' });
  }
});

// Update user role
app.put('/api/users/:id/role', async (req, res) => {
  try {
    const userId = req.params.id;
    const { roleId } = req.body;

    if (!roleId) {
      return res.status(400).json({ error: 'Role ID is required' });
    }

    // Find the role
    const role = await Role.findById(roleId);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Update user's role in the user document
    const user = await User.findByIdAndUpdate(
      userId,
      { role: role.name },
      { new: true }
    ).select('username avatar isOnline lastSeen role createdAt updatedAt');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Statistics API endpoint
app.get('/api/statistics', async (req, res) => {
  try {
    // Get user statistics
    const totalUsers = await User.countDocuments();
    const onlineUsers = await User.countDocuments({ isOnline: true });
    
    // Get message statistics
    const totalMessages = await Message.countDocuments();
    
    // Get channel statistics
    const totalChannels = await Channel.countDocuments({ isActive: true });
    const textChannels = await Channel.countDocuments({ isActive: true, type: 'text' });
    const voiceChannels = await VoiceChannel.countDocuments();
    
    // Get role statistics
    const totalRoles = await Role.countDocuments();
    
    // Get connection statistics
    const connectedUsers = activeConnections.size;
    const totalConnections = io.engine.clientsCount || 0;
    
    const statistics = {
      totalUsers,
      onlineUsers,
      totalMessages,
      totalChannels: totalChannels + voiceChannels,
      textChannels,
      voiceChannels,
      totalRoles,
      connectedUsers,
      totalConnections,
      serverStatus: 'online',
      lastUpdated: new Date()
    };
    
    res.json(statistics);
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Initialize channels on startup
initializeChannels();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`MongoDB URI: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/solhub'}`);
});