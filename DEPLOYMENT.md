# WebRTC SFU 集群部署指南

## 目录
- [1. 系统要求](#1-系统要求)
- [2. 服务器准备](#2-服务器准备)
- [3. 信令服务器部署](#3-信令服务器部署)
- [4. Redis部署](#4-redis部署)
- [5. SFU服务器部署](#5-sfu服务器部署)
- [6. 网络配置](#6-网络配置)
- [7. 监控配置](#7-监控配置)
- [8. 维护指南](#8-维护指南)
- [9. 故障排除](#9-故障排除)

## 1. 系统要求

### 1.1 信令服务器要求
- CPU: 至少2核心
- 内存: 至少4GB RAM
- 存储: 至少20GB SSD
- 网络: 至少50Mbps带宽

### 1.2 SFU服务器要求（每台）
- CPU: 至少4核心
- 内存: 至少8GB RAM
- 存储: 至少50GB SSD
- 网络: 至少100Mbps带宽，建议1Gbps

### 1.3 软件要求
所有服务器：
- Ubuntu 20.04 LTS或更高版本
- Node.js 18.x或更高版本
- PM2进程管理器

额外要求：
- Redis 6.x或更高版本（Redis主服务器）

## 2. 服务器准备

### 2.1 基础系统配置（所有服务器都需要）

```bash
# 更新系统
sudo apt-get update
sudo apt-get upgrade -y

# 安装基础工具
sudo apt-get install -y curl git build-essential python3 htop iftop

# 安装Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装PM2
sudo npm install -g pm2

# 创建应用目录
sudo mkdir -p /opt/tgrtc
sudo chown -R $USER:$USER /opt/tgrtc

# 配置系统参数
sudo tee -a /etc/sysctl.conf > /dev/null <<EOT
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.core.rmem_default=16777216
net.core.wmem_default=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 87380 16777216
EOT

# 应用系统参数
sudo sysctl -p
```

### 2.2 防火墙配置

```bash
# 安装UFW
sudo apt-get install -y ufw

# 信令服务器防火墙规则
sudo ufw allow 22/tcp        # SSH
sudo ufw allow 3000/tcp      # 信令服务器端口

# SFU服务器防火墙规则
sudo ufw allow 22/tcp        # SSH
sudo ufw allow 3001/tcp      # SFU服务
sudo ufw allow 6379/tcp      # Redis（仅在Redis主服务器上需要）

# 启用防火墙
sudo ufw enable
```

## 3. 信令服务器部署

### 3.1 环境变量配置

在信令服务器上创建 `/opt/tgrtc/.env` 文件：

```bash
export NODE_ENV=production
export PORT=3000
export REDIS_HOST=<REDIS-SERVER-IP>
export REDIS_PORT=6379
export REDIS_PASSWORD=your_strong_password
export SFU_SERVERS='[
  {"id":"sfu-1","host":"45.76.155.224","port":3001},
  {"id":"sfu-2","host":"216.128.136.217","port":3001}
]'
```

### 3.2 应用部署

```bash
cd /opt/tgrtc

# 克隆代码
git clone https://github.com/Viiiiiiivvvvvi/Tgrtc .

# 安装依赖
npm install

# 创建PM2配置文件
cat > ecosystem.config.js <<EOT
module.exports = {
  apps: [{
    name: 'signaling-server',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
EOT

# 启动服务
pm2 start ecosystem.config.js
pm2 save
pm2 startup ubuntu

# 设置日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### 3.3 Nginx配置（可选，用于SSL和反向代理）

```bash
# 安装Nginx
sudo apt-get install -y nginx

# 配置Nginx
sudo tee /etc/nginx/sites-available/tgrtc <<EOT
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOT

# 启用站点
sudo ln -s /etc/nginx/sites-available/tgrtc /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## 4. Redis部署

### 4.1 安装Redis

```bash
# 安装Redis
sudo apt-get install -y redis-server

# 备份原配置
sudo cp /etc/redis/redis.conf /etc/redis/redis.conf.backup

# 创建并设置数据目录权限
sudo mkdir -p /var/lib/redis/data
sudo chown -R redis:redis /var/lib/redis
sudo chmod 770 /var/lib/redis/data

# 配置Redis
sudo tee /etc/redis/redis.conf > /dev/null <<EOT
bind 0.0.0.0
port 6379
requirepass vicky022
maxmemory 1gb
maxmemory-policy allkeys-lru

# 持久化配置
appendonly yes
appendfsync everysec
appendfilename "appendonly.aof"
dir /var/lib/redis/data

# 确保系统有足够的内存提交
vm.overcommit_memory = 1
EOT

# 设置内存过量使用参数
echo vm.overcommit_memory=1 | sudo tee -a /etc/sysctl.conf
sudo sysctl vm.overcommit_memory=1
sudo sysctl -p

# 重启Redis服务
sudo systemctl restart redis-server


# 禁用透明大页面
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo 'echo never > /sys/kernel/mm/transparent_hugepage/enabled' | sudo tee -a /etc/rc.local
sudo chmod +x /etc/rc.local

# 重启Redis服务
sudo systemctl restart redis-server
sudo systemctl enable redis-server

# 验证Redis状态
redis-cli -a vicky022 ping
```

### 4.2 Redis持久化配置

```bash
# 创建备份目录
sudo mkdir -p /var/lib/redis/backup
sudo chown redis:redis /var/lib/redis/backup

# 设置定时备份
sudo tee /etc/cron.daily/redis-backup > /dev/null <<EOT
#!/bin/bash
BACKUP_DIR="/var/lib/redis/backup"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
redis-cli -a your_strong_password SAVE
cp /var/lib/redis/dump.rdb \$BACKUP_DIR/dump_\$TIMESTAMP.rdb
find \$BACKUP_DIR -type f -mtime +7 -delete
EOT

sudo chmod +x /etc/cron.daily/redis-backup
```

## 5. SFU服务器部署

### 5.1 环境变量配置
sudo mkdir -p /opt/tgrtc-sfu

在每台SFU服务器上创建 `/opt/tgrtc-sfu/.env` 文件：

```bash
# SFU-1的配置
export NODE_ENV=production
export SFU_ID=sfu-1
export SFU_HOST=45.76.155.224
export SFU_PORT=3001
export REDIS_HOST=45.77.158.151
export REDIS_PORT=6379
export REDIS_PASSWORD=vicky022
export MAX_LOAD=50

# SFU-2的配置（修改相应的SFU_ID和SFU_HOST）
export NODE_ENV=production
export SFU_ID=sfu-2
export SFU_HOST=216.128.136.217
export SFU_PORT=3001
export REDIS_HOST=45.77.158.151
export REDIS_PORT=6379
export REDIS_PASSWORD=vicky022
export MAX_LOAD=50
```

### 5.2 部署应用

在每台服务器上执行：

```bash
cd /opt/tgrtc-sfu

# 克隆代码（替换为实际的代码仓库地址）
git clone https://github.com/Viiiiiiivvvvvi/Tgrtc .

# 安装依赖
npm install

# 配置PM2
pm2 startup ubuntu
pm2 start ecosystem.config.js
pm2 save

# 设置日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## 6. 网络配置

### 6.1 STUN/TURN服务器配置

编辑 `config.js` 文件，添加STUN/TURN服务器配置：

```javascript
webrtc: {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server:3478',
      username: 'your-username',
      credential: 'your-password'
    }
  ]
}
```

### 6.2 SSL配置（如果需要）

```bash
# 安装Certbot
sudo apt-get install -y certbot

# 获取证书
sudo certbot certonly --standalone -d sfu1.yourdomain.com
sudo certbot certonly --standalone -d sfu2.yourdomain.com

# 配置证书自动更新
sudo certbot renew --dry-run
```

## 7. 监控配置

### 7.1 系统监控

```bash
# 安装监控工具
sudo apt-get install -y prometheus node-exporter grafana

# 配置Prometheus
sudo tee /etc/prometheus/prometheus.yml > /dev/null <<EOT
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
EOT

# 启动监控服务
sudo systemctl restart prometheus
sudo systemctl restart node-exporter
sudo systemctl restart grafana-server
```

### 7.2 应用监控

```bash
# 安装PM2监控模块
pm2 install pm2-prometheus-exporter

# 设置日志监控
sudo tee /etc/logrotate.d/pm2 > /dev/null <<EOT
/root/.pm2/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
EOT
```

## 8. 维护指南

### 8.1 日常维护命令

```bash
# 查看服务状态
pm2 status
pm2 logs sfu-server

# 重启服务
pm2 restart sfu-server

# 更新代码
cd /opt/tgrtc-sfu
git pull
npm install
pm2 restart sfu-server

# 检查Redis状态
redis-cli -h <REDIS-SERVER-IP> -a your_strong_password info
```

### 8.2 性能调优

```bash
# 检查系统资源使用情况
htop
iftop

# 检查Node.js内存使用
pm2 monit

# 检查Redis内存使用
redis-cli -h <REDIS-SERVER-IP> -a your_strong_password info memory
```

## 9. 故障排除

### 9.1 常见问题检查

```bash
# 检查服务日志
pm2 logs sfu-server

# 检查系统日志
sudo journalctl -u pm2-root

# 检查Redis连接
redis-cli -h <REDIS-SERVER-IP> -a your_strong_password ping

# 检查网络连接
netstat -tulpn | grep LISTEN
```

### 9.2 性能问题排查

```bash
# CPU使用率高
top -c

# 内存使用率高
free -m
vmstat 1

# 网络问题
iftop -i eth0
tcpdump -i eth0 port 3001
```

### 9.3 恢复步骤

1. 服务器重启后：
```bash
cd /opt/tgrtc-sfu
source .env
pm2 start ecosystem.config.js
```

2. Redis数据恢复：
```bash
sudo cp /var/lib/redis/backup/dump_latest.rdb /var/lib/redis/dump.rdb
sudo systemctl restart redis
```

## 重要提示

1. 定期备份Redis数据
2. 监控系统资源使用情况
3. 保持系统和依赖包更新
4. 定期检查日志文件
5. 设置适当的告警阈值

## 配置检查清单

- [ ] 系统更新完成
- [ ] Node.js安装正确
- [ ] Redis配置正确
- [ ] 防火墙规则设置
- [ ] 环境变量配置
- [ ] PM2配置完成
- [ ] 监控系统部署
- [ ] 日志轮转设置
- [ ] SSL证书配置（如需要）
- [ ] 备份策略制定
