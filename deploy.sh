#!/bin/bash
# deploy.sh — Deploy TVMbot v4 to VPS
# Run this from your local machine or CI
# Usage: ./deploy.sh

set -e

VPS="root@212.85.24.204"
REMOTE_DIR="/root/tvmbot-v4"
OLD_DIR="/root/claude-chatbot"

echo "=== TVMbot v4 Deploy ==="

# 1. Back up old bot (first time only)
echo "[1/5] Backing up old bot..."
ssh $VPS "[ -d ${OLD_DIR} ] && [ ! -d ${OLD_DIR}-backup ] && cp -r ${OLD_DIR} ${OLD_DIR}-backup || echo 'Backup exists or not needed'"

# 2. Stop old bot
echo "[2/5] Stopping old bot..."
ssh $VPS "pm2 stop tvmbot 2>/dev/null || true"

# 3. Copy v4 files (exclude .env, node_modules, wa-session)
echo "[3/5] Uploading v4..."
rsync -avz --exclude='node_modules' --exclude='.env' --exclude='wa-session' \
  ./ $VPS:$REMOTE_DIR/

# 4. Install dependencies & set up env
echo "[4/5] Installing deps..."
ssh $VPS "cd $REMOTE_DIR && npm install --production"

# 5. Start with PM2
echo "[5/5] Starting v4..."
ssh $VPS "cd $REMOTE_DIR && pm2 delete tvmbot-v4 2>/dev/null || true && pm2 start index.js --name tvmbot-v4 && pm2 save"

echo "=== Done! ==="
echo "Check: ssh $VPS 'pm2 logs tvmbot-v4 --lines 20'"
