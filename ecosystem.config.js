module.exports = {
  apps: [{
    name: 'sfu-server',
    script: 'sfu-server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      REDIS_HOST: 'sfu-1-ip', // 替换为SFU-1服务器的IP
      REDIS_PORT: 6379,
      REDIS_PASSWORD: 'your_strong_password'
    }
  }]
};
