#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

AUTHORIZED_KEYS="$TMP_DIR/authorized_keys"
PUBLIC_KEY="$TMP_DIR/deploy-key.pub"
printf '%s\n' 'ssh-ed25519 AAAATEST existing@example' > "$AUTHORIZED_KEYS"
printf '%s\n' 'ssh-ed25519 AAAANEW deploy@example' > "$PUBLIC_KEY"

bash "$REPO_DIR/ops/install-authorized-key.sh" "$PUBLIC_KEY" "$AUTHORIZED_KEYS"
bash "$REPO_DIR/ops/install-authorized-key.sh" "$PUBLIC_KEY" "$AUTHORIZED_KEYS"

test "$(grep -Fc 'ssh-ed25519 AAAANEW deploy@example' "$AUTHORIZED_KEYS")" -eq 1
test "$(grep -Fc 'ssh-ed25519 AAAATEST existing@example' "$AUTHORIZED_KEYS")" -eq 1
test "$(stat -f '%Lp' "$AUTHORIZED_KEYS" 2>/dev/null || stat -c '%a' "$AUTHORIZED_KEYS")" = "600"

echo "authorized-key installer test passed"
