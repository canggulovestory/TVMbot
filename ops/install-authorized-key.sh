#!/bin/bash
set -euo pipefail

PUBLIC_KEY_FILE="${1:?public key file required}"
AUTHORIZED_KEYS_FILE="${2:-/root/.ssh/authorized_keys}"

test -s "$PUBLIC_KEY_FILE"
install -d -m 700 "$(dirname "$AUTHORIZED_KEYS_FILE")"
touch "$AUTHORIZED_KEYS_FILE"
chmod 600 "$AUTHORIZED_KEYS_FILE"

PUBLIC_KEY="$(tr -d '\r\n' < "$PUBLIC_KEY_FILE")"
if ! grep -Fqx "$PUBLIC_KEY" "$AUTHORIZED_KEYS_FILE"; then
  printf '%s\n' "$PUBLIC_KEY" >> "$AUTHORIZED_KEYS_FILE"
fi
