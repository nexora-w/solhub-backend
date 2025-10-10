require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/database');
const User = require('./models/User');
const Message = require('./models/Message');
const Channel = require('./models/Channel');

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
    for (const channelName of channels) {
      const existingChannel = await Channel.findOne({ name: channelName });
      if (!existingChannel) {
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
        
        const channel = new Channel({
          name: channelName,
          description: `Default ${channelName} channel`,
          createdBy: systemUser._id
        });
        await channel.save();
        console.log(`Initialized channel: ${channelName}`);
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
      .select('username avatar isOnline lastSeen joinedAt')
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

// Initialize channels on startup
initializeChannels();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`MongoDB URI: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/solhub'}`);
});