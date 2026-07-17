#!/bin/bash
# deploy.sh — Deploy TVMbot v4 to VPS
# Run this from your local machine or CI
# Usage: ./deploy.sh

set -e

VPS="root@212.85.24.204"
REMOTE_DIR="/root/tvmbot-v4"
PUBLIC_DIR="/root/tvm-website"
OLD_DIR="/root/claude-chatbot"

echo "=== TVMbot v4 Deploy ==="

# 1. Back up old bot (first time only)
echo "[1/6] Backing up old bot..."
ssh $VPS "[ -d ${OLD_DIR} ] && [ ! -d ${OLD_DIR}-backup ] && cp -r ${OLD_DIR} ${OLD_DIR}-backup || echo 'Backup exists or not needed'"

# 2. Stop old bot
echo "[2/6] Stopping old bot..."
ssh $VPS "pm2 stop tvmbot 2>/dev/null || true"

# 3. Copy v4 files (exclude .env, node_modules, wa-session)
echo "[3/6] Uploading v4..."
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='wa-session' \
  ./ $VPS:$REMOTE_DIR/

# 4. Install dependencies & set up env
echo "[4/6] Installing deps..."
ssh $VPS "cd $REMOTE_DIR && npm install --production"

# 5. Publish all public routes and the versioned Nginx routing
echo "[5/6] Publishing website + protected routes..."
ssh $VPS "install -d -m 755 $PUBLIC_DIR && rsync -a --delete $REMOTE_DIR/website/ $PUBLIC_DIR/ && install -m 644 $REMOTE_DIR/ops/nginx-tvmbot.conf /etc/nginx/sites-available/tvmbot && ln -sfn /etc/nginx/sites-available/tvmbot /etc/nginx/sites-enabled/tvmbot && nginx -t && systemctl reload nginx"

# 6. Start with PM2
echo "[6/6] Starting v4..."
ssh $VPS "cd $REMOTE_DIR && pm2 delete tvmbot-v4 2>/dev/null || true && pm2 start index.js --name tvmbot-v4 && pm2 save"

# Keep GitHub and the VPS synchronized after every future push to main.
ssh $VPS "chmod 700 $REMOTE_DIR/ops/sync-and-deploy.sh && install -m 644 $REMOTE_DIR/ops/tvm-sync.service /etc/systemd/system/tvm-sync.service && install -m 644 $REMOTE_DIR/ops/tvm-sync.timer /etc/systemd/system/tvm-sync.timer && systemctl daemon-reload && systemctl enable --now tvm-sync.timer"

echo "=== Done! ==="
echo "Check: ssh $VPS 'pm2 logs tvmbot-v4 --lines 20'"
