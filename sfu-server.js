const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const wrtc = require('wrtc');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const SFUClusterManager = require('./sfu-cluster-manager');

// 视频编码配置
const videoEncoderConfig = {
  low: {
    maxBitrate: 800000,    // 800 kbps
    scaleResolutionDownBy: 2,  // 360p
    maxFramerate: 15,
    height: 720,
    width: 1280,
    codec: 'H264'
  },
  medium: {
    maxBitrate: 1500000,   // 1.5 Mbps
    scaleResolutionDownBy: 1.5,  // 480p
    maxFramerate: 25,
    height: 720,
    width: 1280,
    codec: 'H264'
  },
  high: {
    maxBitrate: 2500000,   // 2.5 Mbps
    scaleResolutionDownBy: 1,    // 720p
    maxFramerate: 30,
    height: 720,
    width: 1280,
    codec: 'H264'
  }
};

// H.264编码器参数
const h264Params = {
  profileLevelId: '42e01f',  // High Profile Level 3.1
  packetizationMode: 1,      // 单NAL单元模式
  levelAsymmetryAllowed: 1,  // 允许非对称级别
  'x-google-start-bitrate': 1000,  // 初始比特率1000 kbps
  'x-google-min-bitrate': 500,     // 最小比特率500 kbps
  'x-google-max-bitrate': 2500     // 最大比特率2.5 Mbps
};

// 音频编码配置
const audioEncoderConfig = {
  low: {
    maxBitrate: 16000,     // 16 kbps
    channelCount: 1,
    sampleRate: 8000
  },
  medium: {
    maxBitrate: 32000,     // 32 kbps
    channelCount: 1,
    sampleRate: 16000
  },
  high: {
    maxBitrate: 64000,     // 64 kbps
    channelCount: 2,
    sampleRate: 48000
  }
};

// SFU配置
const sfuConfig = {
  sfuId: process.env.SFU_ID || uuidv4(),
  host: process.env.SFU_HOST || 'localhost',
  port: parseInt(process.env.SFU_PORT) || 3001,
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD
  },
  maxLoad: parseInt(process.env.MAX_LOAD) || 100
};

// 初始化集群管理器
const clusterManager = new SFUClusterManager(sfuConfig);

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
  console.log(`SFU ${sfuConfig.sfuId}: Client connected ${socket.id}`);

  // 处理加入房间请求
  socket.on('join-room', async ({ roomId, userId, quality = 'medium' }) => {
    try {
      // 检查房间是否已分配给其他SFU
      const assignedSFU = await clusterManager.getRoomSFU(roomId);
      
      if (assignedSFU && assignedSFU !== sfuConfig.sfuId) {
        // 如果房间在其他SFU上，重定向客户端
        const sfuNodes = await clusterManager.getActiveSFUNodes();
        const targetSFU = sfuNodes.find(node => node.sfuId === assignedSFU);
        
        if (targetSFU) {
          socket.emit('redirect', {
            sfuId: targetSFU.sfuId,
            host: targetSFU.host,
            port: targetSFU.port
          });
          return;
        }
      }

      // 如果是新房间，检查负载并决定是否接受
      if (!assignedSFU) {
        const bestSFU = await clusterManager.selectBestSFU();
        if (bestSFU && bestSFU.sfuId !== sfuConfig.sfuId) {
          // 如果有更好的SFU可用，重定向到该SFU
          socket.emit('redirect', {
            sfuId: bestSFU.sfuId,
            host: bestSFU.host,
            port: bestSFU.port
          });
          return;
        }
        // 注册房间到当前SFU
        await clusterManager.registerRoom(roomId);
      }

      console.log(`User ${userId} joining room ${roomId} with quality ${quality}`);
      
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add({ userId, quality });
      socket.join(roomId);

      // 更新负载信息
      const totalConnections = Array.from(rooms.values())
        .reduce((sum, room) => sum + room.size, 0);
      await clusterManager.updateCurrentLoad(totalConnections);

      // 通知房间其他用户有新成员加入
      socket.to(roomId).emit('user-joined', { userId });
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // 处理发布者的SDP offer
  socket.on('publisher-offer', async ({ roomId, userId, sdp }) => {
    try {
      const pc = new wrtc.RTCPeerConnection(rtcConfig);
      peerConnections.set(`${roomId}_${userId}`, pc);

      // 设置远程描述
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp));
      
      // 创建应答，添加编码约束
      const answer = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      // 修改SDP以强制使用H.264编码器和参数
      let modifiedSdp = answer.sdp;
      
      // 确保H.264是首选编解码器
      modifiedSdp = modifiedSdp.replace(
        /m=video (\d+) UDP\/TLS\/RTP\/SAVPF.*/,
        (line) => {
          const parts = line.split(' ');
          // 找到H.264的PT（Payload Type）
          const h264Pt = parts.find((pt, index) => {
            return modifiedSdp.includes(`a=rtpmap:${pt} H264`);
          });
          if (h264Pt) {
            // 将H.264移到首位
            parts.splice(3, 1);
            parts.splice(3, 0, h264Pt);
            return parts.join(' ');
          }
          return line;
        }
      );

      // 添加H.264特定参数
      modifiedSdp = modifiedSdp.replace(
        /(a=fmtp:\d+ (?:H264|h264).*)/,
        `$1;profile-level-id=${h264Params.profileLevelId};packetization-mode=${h264Params.packetizationMode};level-asymmetry-allowed=${h264Params.levelAsymmetryAllowed}`
      );

      // 添加分辨率和帧率约束
      modifiedSdp = modifiedSdp.replace(
        /a=mid:video\r\n/,
        'a=mid:video\r\na=imageattr:* recv [x=1280,y=720] send [x=1280,y=720]\r\n'
      );

      answer.sdp = modifiedSdp;
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

      // 处理媒体流，应用转码
      pc.ontrack = (event) => {
        const track = event.track;
        const stream = event.streams[0];

        if (track.kind === 'video') {
          // 应用视频约束
          const videoTrack = track;
          videoTrack.applyConstraints({
            width: { exact: 1280 },
            height: { exact: 720 },
            frameRate: { max: 30 }
          });
        }

        // 转发流到房间中的其他用户
        rooms.get(roomId).forEach(async (subscriber) => {
          if (subscriber.userId !== userId) {
            try {
              const subscriberPc = new wrtc.RTCPeerConnection(rtcConfig);
              peerConnections.set(`${roomId}_${userId}_${subscriber.userId}`, subscriberPc);
              
              // 根据订阅者请求的质量选择编码配置
              const videoConfig = videoEncoderConfig[subscriber.quality];

              if (track.kind === 'video') {
                const sender = subscriberPc.addTrack(track, stream);
                const params = sender.getParameters();
                
                // 设置编码参数
                params.encodings = [{
                  maxBitrate: videoConfig.maxBitrate,
                  scaleResolutionDownBy: videoConfig.scaleResolutionDownBy,
                  maxFramerate: videoConfig.maxFramerate
                }];

                // 设置编解码器首选项
                if (!params.codecs) {
                  params.codecs = [];
                }
                params.codecs.unshift({
                  mimeType: 'video/H264',
                  clockRate: 90000,
                  parameters: h264Params
                });

                await sender.setParameters(params);
              } else if (track.kind === 'audio') {
                subscriberPc.addTrack(track, stream);
              }

              // 创建并发送offer给订阅者
              const offer = await subscriberPc.createOffer();
              // 确保在offer中也使用H.264
              offer.sdp = offer.sdp.replace(
                /(a=fmtp:\d+ (?:H264|h264).*)/,
                `$1;profile-level-id=${h264Params.profileLevelId};packetization-mode=${h264Params.packetizationMode}`
              );
              await subscriberPc.setLocalDescription(offer);
              
              socket.emit('subscriber-offer', {
                publisherId: userId,
                subscriberId: subscriber.userId,
                sdp: subscriberPc.localDescription
              });
            } catch (error) {
              console.error(`Error setting up transcoding for ${subscriber.userId}:`, error);
            }
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
  socket.on('leave-room', async ({ roomId, userId }) => {
    try {
      if (rooms.has(roomId)) {
        rooms.get(roomId).forEach((participant) => {
          if (participant.userId === userId) {
            rooms.get(roomId).delete(participant);
          }
        });

        if (rooms.get(roomId).size === 0) {
          rooms.delete(roomId);
          // 清除房间分配
          await clusterManager.migrateRoom(roomId, null);
        }
      }

      // 清理连接
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

      // 更新负载信息
      const totalConnections = Array.from(rooms.values())
        .reduce((sum, room) => sum + room.size, 0);
      await clusterManager.updateCurrentLoad(totalConnections);

      socket.to(roomId).emit('user-left', { userId });
    } catch (error) {
      console.error('Error in leave-room:', error);
    }
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SFU Server ${sfuConfig.sfuId} running on port ${PORT}`);
});
