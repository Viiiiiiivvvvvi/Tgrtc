const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const wrtc = require('wrtc');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// 启用CORS
app.use(cors({
  origin: '*', // 在生产环境中应该设置为具体的信令服务器域名
  methods: ['GET', 'POST']
}));

// 配置Socket.IO，允许跨域连接
const io = socketIo(server, {
  cors: {
    origin: '*', // 在生产环境中应该设置为具体的信令服务器域名
    methods: ['GET', 'POST']
  }
});

// 存储房间和连接信息
const rooms = new Map();
const peerConnections = new Map();

// WebRTC配置
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

io.on('connection', (socket) => {
  console.log(`SFU: Client connected ${socket.id}`);

  // 处理加入房间请求
  socket.on('join-room', async ({ roomId, userId }) => {
    console.log(`User ${userId} joining room ${roomId}`);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(userId);
    socket.join(roomId);

    // 通知房间其他用户有新成员加入
    socket.to(roomId).emit('user-joined', { userId });
  });

  // 处理发布者的SDP offer
  socket.on('publisher-offer', async ({ roomId, userId, sdp }) => {
    try {
      const pc = new wrtc.RTCPeerConnection(rtcConfig);
      peerConnections.set(`${roomId}_${userId}`, pc);

      // 设置远程描述
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
      
      // 创建应答
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // 发送应答给发布者
      socket.emit('publisher-answer', { sdp: pc.localDescription });

      // 处理ICE候选
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', {
            userId,
            candidate: event.candidate
          });
        }
      };

      // 处理媒体流
      pc.ontrack = (event) => {
        // 转发流到房间中的其他用户
        rooms.get(roomId).forEach(async (subscriberId) => {
          if (subscriberId !== userId) {
            // 为每个订阅者创建新的PeerConnection
            const subscriberPc = new wrtc.RTCPeerConnection(rtcConfig);
            peerConnections.set(`${roomId}_${userId}_${subscriberId}`, subscriberPc);
            
            // 添加track到订阅者的PeerConnection
            subscriberPc.addTrack(event.track, event.streams[0]);
          }
        });
      };
    } catch (error) {
      console.error('Error handling publisher offer:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // 处理订阅者的请求
  socket.on('subscriber-request', async ({ roomId, publisherId, subscriberId }) => {
    try {
      const pc = peerConnections.get(`${roomId}_${publisherId}_${subscriberId}`);
      if (!pc) {
        throw new Error('Publisher connection not found');
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('subscriber-offer', {
        publisherId,
        sdp: pc.localDescription
      });
    } catch (error) {
      console.error('Error handling subscriber request:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // 处理离开房间
  socket.on('leave-room', ({ roomId, userId }) => {
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(userId);
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
      }
    }

    // 清理PeerConnections
    const publisherPc = peerConnections.get(`${roomId}_${userId}`);
    if (publisherPc) {
      publisherPc.close();
      peerConnections.delete(`${roomId}_${userId}`);
    }

    // 清理所有相关的订阅者连接
    peerConnections.forEach((pc, key) => {
      if (key.startsWith(`${roomId}_${userId}_`) || key.endsWith(`_${userId}`)) {
        pc.close();
        peerConnections.delete(key);
      }
    });

    socket.to(roomId).emit('user-left', { userId });
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SFU Server running on port ${PORT}`);
});
