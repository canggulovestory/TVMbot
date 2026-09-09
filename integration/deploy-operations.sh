#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
commit=${1:?verified commit}; bundle=${2:?bundle}
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
cd /root/tvmbot-v4
git diff --quiet
git diff --cached --quiet
test ! -e /etc/zuzu-runtime/operations-chat.json
git bundle verify "$bundle"
git fetch "$bundle" refs/heads/feat/protected-task-villa-connector
test "$(git rev-parse FETCH_HEAD)" = "$commit"
old=$(git rev-parse HEAD)
git merge-base --is-ancestor "$old" "$commit"
systemctl stop tvm-sync.timer
exec 9>/var/lock/tvm-sync.lock
flock -w 30 9
backup=$(mktemp -d /var/backups/zuzu-operations-cutover.XXXXXXXX)
git archive -o "$backup/source.tar" "$old"
systemctl cat tvm-hermes.service > "$backup/old-hermes.service"
switched=false
rollback(){
 result=$?
 if [ "$result" != 0 ]; then
  systemctl stop zuzu-operations.service || true
  if [ "$switched" = true ]; then git switch --detach "$old"; cp "$backup/.env" .env; fi
  systemctl enable --now tvm-hermes.service
  pm2 restart tvmbot-v4 --update-env
  echo "Cutover failed; previous code restored. Backup: $backup" >&2
 fi
 systemctl start tvm-sync.timer
}
trap rollback EXIT
pm2 stop tvmbot-v4
systemctl stop tvm-hermes.service
cp -a .env "$backup/.env"
tar -czf "$backup/private-data.tar.gz" data .env
mkdir "$backup/restore-check"
tar -xzf "$backup/private-data.tar.gz" -C "$backup/restore-check"
diff -qr data "$backup/restore-check/data"
git merge --ff-only "$commit"
switched=true
diff -qr data "$backup/restore-check/data"
node integration/provision-operations.cjs prepare
install -d -m 700 /var/lib/zuzu-operations
install -m 644 ops/zuzu-operations.service /etc/systemd/system/zuzu-operations.service
systemctl daemon-reload
systemctl enable --now zuzu-operations.service
systemctl disable tvm-hermes.service
pm2 restart tvmbot-v4 --update-env
pm2 save
for attempt in {1..30}; do
 if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18643/v1/operations || true)" = 401 ] && curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null; then
  systemctl is-active --quiet zuzu-hermes-isolated.service
  echo "Protected TVM chat deployed. Private backup: $backup"
  sha256sum "$backup/private-data.tar.gz"
  exit 0
 fi
 sleep 1
done
exit 1
