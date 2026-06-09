#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-picset}"
APP_PORT="${APP_PORT:-4173}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/picset}"
RELEASE_DIR="${RELEASE_DIR:-/tmp/picset-release}"
ENV_FILE="${ENV_FILE:-/etc/picset.env}"
RUN_USER="${RUN_USER:-$(id -un)}"

sudo_run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if sudo -n true 2>/dev/null; then
    sudo "$@"
    return
  fi

  if [ -z "${SUDO_PASSWORD:-}" ]; then
    echo "SUDO_PASSWORD is required for privileged deployment steps" >&2
    exit 1
  fi

  printf '%s\n' "$SUDO_PASSWORD" | sudo -S -p '' "$@"
}

install_node_if_missing() {
  if command -v node >/dev/null 2>&1; then
    return
  fi

  sudo_run apt-get update
  sudo_run apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
  sudo_run bash /tmp/nodesource_setup.sh
  sudo_run apt-get install -y nodejs
}

install_system_packages() {
  if ! command -v rsync >/dev/null 2>&1; then
    sudo_run apt-get update
    sudo_run apt-get install -y rsync
  fi
}

write_env_file_if_present() {
  if [ -z "${PICSET_ENV_B64:-}" ]; then
    if [ ! -f "$ENV_FILE" ]; then
      printf '# Optional Picset runtime env\n' | sudo_run tee "$ENV_FILE" >/dev/null
      sudo_run chmod 600 "$ENV_FILE"
    fi
    return
  fi

  printf '%s' "$PICSET_ENV_B64" | base64 -d | sudo_run tee "$ENV_FILE" >/dev/null
  sudo_run chmod 600 "$ENV_FILE"
}

install_service() {
  local node_bin
  node_bin="$(command -v node)"

  cat >/tmp/"$APP_NAME".service <<SERVICE
[Unit]
Description=Picset image creation workbench
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DEPLOY_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
EnvironmentFile=-$ENV_FILE
ExecStart=$node_bin $DEPLOY_DIR/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

  sudo_run mv /tmp/"$APP_NAME".service /etc/systemd/system/"$APP_NAME".service
  sudo_run systemctl daemon-reload
  sudo_run systemctl enable "$APP_NAME"
}

deploy_release() {
  test -f "$RELEASE_DIR/server.mjs"
  test -f "$RELEASE_DIR/package.json"

  sudo_run mkdir -p "$DEPLOY_DIR"
  sudo_run rsync -a --delete \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='node_modules' \
    "$RELEASE_DIR"/ "$DEPLOY_DIR"/
  sudo_run chown -R "$RUN_USER:$RUN_USER" "$DEPLOY_DIR"

  cd "$DEPLOY_DIR"
  npm install --omit=dev --package-lock=false
}

open_local_firewall_if_active() {
  if ! command -v ufw >/dev/null 2>&1; then
    return
  fi

  if sudo_run ufw status | grep -q "Status: active"; then
    sudo_run ufw allow "$APP_PORT"/tcp
  fi
}

install_node_if_missing
install_system_packages
write_env_file_if_present
deploy_release
install_service
open_local_firewall_if_active
sudo_run systemctl restart "$APP_NAME"
sudo_run systemctl --no-pager --full status "$APP_NAME"
