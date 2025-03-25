#!/bin/bash

# 检查参数
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <server-ip> <sfu-id>"
    exit 1
fi

SERVER_IP=$1
SFU_ID=$2
DEPLOY_PATH="/opt/tgrtc-sfu"
SSH_USER="ubuntu"  # 替换为你的SSH用户名

echo "Deploying to $SERVER_IP as SFU $SFU_ID..."

# 创建远程目录
ssh $SSH_USER@$SERVER_IP "sudo mkdir -p $DEPLOY_PATH && sudo chown -R $SSH_USER:$SSH_USER $DEPLOY_PATH"

# 复制文件到服务器
rsync -avz --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'logs' \
    ./ $SSH_USER@$SERVER_IP:$DEPLOY_PATH/

# SSH到服务器执行部署命令
ssh $SSH_USER@$SERVER_IP "cd $DEPLOY_PATH && \
    npm install && \
    export SFU_ID=$SFU_ID && \
    export SFU_HOST=$SERVER_IP && \
    export SFU_PORT=3001 && \
    pm2 delete sfu-server || true && \
    pm2 start ecosystem.config.js && \
    pm2 save"

echo "Deployment completed for SFU $SFU_ID on $SERVER_IP"
