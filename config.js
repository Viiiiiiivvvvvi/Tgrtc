module.exports = {
  // 信令服务器配置
  signalingServer: {
    port: process.env.SIGNALING_PORT || 3000,
    host: process.env.SIGNALING_HOST || 'localhost'
  },
  
  // SFU服务器配置
  sfuServer: {
    port: process.env.SFU_PORT || 3001,
    host: process.env.SFU_HOST || 'localhost',
    // 在生产环境中修改为实际的SFU服务器地址
    url: process.env.SFU_URL || 'http://localhost:3001'
  },
  
  // WebRTC配置
  webrtc: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
      // 在生产环境中可以添加TURN服务器配置
    ]
  }
};
