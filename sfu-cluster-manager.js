const Redis = require('ioredis');
const os = require('os');

class SFUClusterManager {
  constructor(config) {
    this.redis = new Redis(config.redis);
    this.sfuId = config.sfuId;
    this.host = config.host;
    this.port = config.port;
    this.maxLoad = config.maxLoad || 100; // 最大负载数
    this.heartbeatInterval = config.heartbeatInterval || 5000;
    this.currentLoad = 0;
    
    // 启动心跳
    this._startHeartbeat();
  }

  // 更新SFU负载信息
  async updateLoadInfo() {
    const load = {
      sfuId: this.sfuId,
      host: this.host,
      port: this.port,
      load: this.currentLoad,
      cpu: os.loadavg()[0], // CPU负载
      memory: process.memoryUsage().heapUsed,
      connections: this.currentLoad,
      timestamp: Date.now()
    };

    await this.redis.hset(
      'sfu:nodes',
      this.sfuId,
      JSON.stringify(load)
    );
    await this.redis.expire('sfu:nodes', 30); // 30秒过期
  }

  // 获取所有活跃的SFU节点
  async getActiveSFUNodes() {
    const nodes = await this.redis.hgetall('sfu:nodes');
    const activeNodes = [];
    
    for (const [sfuId, nodeInfo] of Object.entries(nodes)) {
      const info = JSON.parse(nodeInfo);
      // 检查节点是否活跃（最近30秒有心跳）
      if (Date.now() - info.timestamp < 30000) {
        activeNodes.push(info);
      }
    }
    
    return activeNodes;
  }

  // 选择最佳SFU节点
  async selectBestSFU() {
    const nodes = await this.getActiveSFUNodes();
    if (nodes.length === 0) return null;

    // 根据负载和资源使用情况计算权重
    return nodes.reduce((best, current) => {
      const currentScore = this._calculateNodeScore(current);
      const bestScore = this._calculateNodeScore(best);
      return currentScore > bestScore ? current : best;
    });
  }

  // 计算节点得分
  _calculateNodeScore(node) {
    const loadScore = 1 - (node.load / this.maxLoad);
    const cpuScore = 1 - (node.cpu / 100);
    const memoryScore = 1 - (node.memory / (1024 * 1024 * 1024)); // 相对于1GB
    
    // 权重配置
    const weights = {
      load: 0.4,
      cpu: 0.4,
      memory: 0.2
    };

    return (loadScore * weights.load) +
           (cpuScore * weights.cpu) +
           (memoryScore * weights.memory);
  }

  // 更新当前负载
  async updateCurrentLoad(connections) {
    this.currentLoad = connections;
    await this.updateLoadInfo();
  }

  // 心跳机制
  _startHeartbeat() {
    setInterval(async () => {
      try {
        await this.updateLoadInfo();
      } catch (error) {
        console.error('Heartbeat error:', error);
      }
    }, this.heartbeatInterval);
  }

  // 注册新的房间
  async registerRoom(roomId) {
    await this.redis.hset('sfu:room_allocation', roomId, this.sfuId);
  }

  // 获取房间所在的SFU
  async getRoomSFU(roomId) {
    return await this.redis.hget('sfu:room_allocation', roomId);
  }

  // 房间迁移
  async migrateRoom(roomId, targetSFUId) {
    await this.redis.hset('sfu:room_allocation', roomId, targetSFUId);
  }
}

module.exports = SFUClusterManager;
