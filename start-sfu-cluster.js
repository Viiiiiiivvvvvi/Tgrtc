const { spawn } = require('child_process');
const path = require('path');

// SFU实例配置
const sfuInstances = [
  {
    id: 'sfu-1',
    port: 3001,
    host: 'localhost'
  },
  {
    id: 'sfu-2',
    port: 3002,
    host: 'localhost'
  }
];

// 启动SFU实例
function startSFUInstance(config) {
  const env = {
    ...process.env,
    SFU_ID: config.id,
    SFU_PORT: config.port.toString(),
    SFU_HOST: config.host,
    REDIS_HOST: process.env.REDIS_HOST || 'localhost',
    REDIS_PORT: process.env.REDIS_PORT || '6379',
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
    MAX_LOAD: '50' // 每个实例最大负载50个连接
  };

  const sfu = spawn('node', ['sfu-server.js'], {
    env,
    stdio: 'inherit',
    cwd: __dirname
  });

  sfu.on('error', (error) => {
    console.error(`Error starting ${config.id}:`, error);
  });

  sfu.on('exit', (code, signal) => {
    console.log(`${config.id} exited with code ${code} and signal ${signal}`);
    // 5秒后重启
    setTimeout(() => {
      console.log(`Restarting ${config.id}...`);
      startSFUInstance(config);
    }, 5000);
  });

  return sfu;
}

// 启动所有SFU实例
console.log('Starting SFU cluster...');
sfuInstances.forEach(config => {
  startSFUInstance(config);
});
