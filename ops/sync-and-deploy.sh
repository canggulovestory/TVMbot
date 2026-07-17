#!/bin/bash
# Runs on the VPS once per minute. A push to main becomes the live version only
# after a fast-forward pull, dependency install, Nginx validation, and PM2 restart.

set -euo pipefail

exec 9>/var/lock/tvm-sync.lock
flock -n 9 || exit 0

REPO_DIR="/root/tvmbot-v4"
PUBLIC_DIR="/root/tvm-website"
BACKUP_DIR="/root/tvm-backups"
NGINX_FILE="/etc/nginx/sites-available/tvmbot"

git -C "$REPO_DIR" fetch origin main
CURRENT_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
TARGET_COMMIT="$(git -C "$REPO_DIR" rev-parse origin/main)"

if [ "$CURRENT_COMMIT" = "$TARGET_COMMIT" ]; then
  exit 0
fi

install -d -m 700 "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/website-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$PUBLIC_DIR" .

git -C "$REPO_DIR" merge --ff-only origin/main
npm ci --omit=dev --prefix "$REPO_DIR"
rsync -a --delete "$REPO_DIR/website/" "$PUBLIC_DIR/"

cp "$NGINX_FILE" "$NGINX_FILE.previous"
install -m 644 "$REPO_DIR/ops/nginx-tvmbot.conf" "$NGINX_FILE"
if ! nginx -t; then
  mv "$NGINX_FILE.previous" "$NGINX_FILE"
  nginx -t
  exit 1
fi
rm -f "$NGINX_FILE.previous"
systemctl reload nginx

pm2 restart tvmbot-v4 --update-env
pm2 save

echo "TVM deployed: $TARGET_COMMIT"
