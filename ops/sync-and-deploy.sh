#!/bin/bash
# Runs on the VPS once per minute. A push to main becomes the live version only
# after a fast-forward pull, dependency install, Hermes/Nginx validation, and
# PM2 restart.

set -euo pipefail

exec 9>/var/lock/tvm-sync.lock
flock -n 9 || exit 0

REPO_DIR="/root/tvmbot-v4"
PUBLIC_DIR="/root/tvm-website"
BACKUP_DIR="/root/tvm-backups"
NGINX_FILE="/etc/nginx/sites-available/tvmbot"
HERMES_SERVICE="/etc/systemd/system/tvm-hermes.service"

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

command -v hermes >/dev/null || { echo "Hermes Agent is not installed" >&2; exit 1; }
hermes -p tvm skills trust "$REPO_DIR"
install -m 644 "$REPO_DIR/ops/hermes/tvm-hermes.service" "$HERMES_SERVICE"
systemctl daemon-reload
systemctl enable tvm-hermes.service
systemctl restart tvm-hermes.service
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8642/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8642/health >/dev/null

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
