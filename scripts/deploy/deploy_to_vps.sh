#!/usr/bin/env bash
# ==============================================================================
# SportsDesk & Fantasy402 Production VPS Deployment Script
# Automatically sets up Bun, Systemd, Nginx, Certbot SSL & Telegram Webhook
# ==============================================================================

set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

APP_DIR="/opt/sportsdesk-ops"
SERVICE_NAME="sportsdesk-ops"
LOCAL_PORT="4020"

echo -e "${CYAN}${BOLD}"
echo "=============================================================================="
echo "    🚀 SportsDesk & Fantasy402 VPS & Domain Deployment Automation"
echo "=============================================================================="
echo -e "${NC}"

# Check for root privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] This deployment script must be run as root (or via sudo).${NC}"
  exit 1
fi

# Gather configuration parameters
DOMAIN="${1:-}"
BOT_TOKEN="${2:-${TELEGRAM_BOT_TOKEN:-}}"
WEBHOOK_SECRET="${3:-deskops_secure_secret_token_$(date +%s)}"

if [ -z "$DOMAIN" ]; then
  echo -e "${YELLOW}Please enter your public domain (e.g. desk.bookdeskops.com or your server domain):${NC}"
  read -r -p "Domain: " DOMAIN
fi

if [ -z "$DOMAIN" ]; then
  echo -e "${RED}[ERROR] Domain name cannot be empty. Please specify a valid domain.${NC}"
  exit 1
fi

echo -e "${BLUE}Target Domain     :${NC} ${BOLD}${DOMAIN}${NC}"
echo -e "${BLUE}Telegram Bot Token:${NC} ${BOLD}${BOT_TOKEN:0:10}...${BOT_TOKEN: -6}${NC}"
echo -e "${BLUE}Webhook Secret    :${NC} ${BOLD}${WEBHOOK_SECRET}${NC}"
echo -e "${BLUE}Application Path  :${NC} ${BOLD}${APP_DIR}${NC}"
echo ""

# Step 1: Install System Dependencies
echo -e "${GREEN}[1/7] Installing system packages (curl, unzip, nginx, certbot)...${NC}"
if command -v apt-get &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq curl unzip ufw nginx certbot python3-certbot-nginx
elif command -v dnf &>/dev/null; then
  dnf install -y -q curl unzip epel-release
  dnf install -y -q nginx certbot python3-certbot-nginx
fi

# Step 2: Install Bun Runtime
echo -e "${GREEN}[2/7] Installing Bun runtime...${NC}"
if ! command -v bun &>/dev/null; then
  # Download to a file first: no network-to-shell pipe. Pin the version so CI and the VPS agree.
  BUN_VERSION="${BUN_VERSION:-1.4.4}"
  BUN_INSTALLER="$(mktemp)"
  curl -fsSL https://bun.sh/install -o "$BUN_INSTALLER"
  sh "$BUN_INSTALLER" "bun-v${BUN_VERSION}"
  rm -f "$BUN_INSTALLER"
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

BUN_BIN="$(which bun || echo "$HOME/.bun/bin/bun")"
echo -e "      Bun binary found at: ${BOLD}${BUN_BIN}${NC}"

# Step 3: Deploy Application Files
echo -e "${GREEN}[3/7] Setting up application directory at ${APP_DIR}...${NC}"
mkdir -p "$APP_DIR" "$APP_DIR/static"

# Copy application tree from repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
for dir in cli services lib static catalog validation; do
  mkdir -p "${APP_DIR}/${dir}"
  cp -R "${REPO_ROOT}/${dir}/." "${APP_DIR}/${dir}/" 2>/dev/null || true
done
mkdir -p "${APP_DIR}/docs"
cp -f "${REPO_ROOT}/docs/graph.html" "${REPO_ROOT}/docs/graph.js" "${REPO_ROOT}/docs/graph-live-feed.json" "${APP_DIR}/docs/" 2>/dev/null || true
mkdir -p "${APP_DIR}/docs/assets"
cp -R "${REPO_ROOT}/docs/assets/." "${APP_DIR}/docs/assets/" 2>/dev/null || true
mkdir -p "${APP_DIR}/design"
cp -R "${REPO_ROOT}/design/." "${APP_DIR}/design/" 2>/dev/null || true
cp -f "${REPO_ROOT}"/*.json "${APP_DIR}/" 2>/dev/null || true
cp -f "${REPO_ROOT}"/*.csv "${APP_DIR}/" 2>/dev/null || true
cp -f "${REPO_ROOT}"/*.xlsx "${APP_DIR}/" 2>/dev/null || true
cp -f "${REPO_ROOT}/package.json" "${APP_DIR}/" 2>/dev/null || true

# Prepare Production .env
if [ -f "${REPO_ROOT}/.env" ]; then
  cp -f "${REPO_ROOT}/.env" "$APP_DIR/.env"
else
  cat <<EOF > "$APP_DIR/.env"
# Fantasy402 Portal Gateway
F402_BASE_URL=\${F402_BASE_URL:-https://fantasy402.com}
F402_AGENT_ID=\${F402_AGENT_ID:-BILLY666}
F402_PASSWORD=\${F402_PASSWORD:-}
F402_OFFLINE_ONLY=0
F402_INITIAL_WATERMARK=0

# Webview & API Server
PORT=\${LOCAL_PORT}
NODE_ENV=production

# Network & Proxy Isolation (Prevents proxy trapping of local loopback calls)
NO_PROXY=127.0.0.1,localhost,::1
BUN_CONFIG_MAX_HTTP_REQUESTS=256

# Cloudflare R2 Storage & API
CLOUDFLARE_ACCOUNT_ID=\${CLOUDFLARE_ACCOUNT_ID:-7a470541a704caaf91e71efccc78fd36}
CLOUDFLARE_API_TOKEN=\${CLOUDFLARE_API_TOKEN:-}
R2_ACCESS_KEY_ID=\${R2_ACCESS_KEY_ID:-}
R2_SECRET_ACCESS_KEY=\${R2_SECRET_ACCESS_KEY:-}
R2_ENDPOINT=\${R2_ENDPOINT:-https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com}
R2_BUCKET_NAME=\${R2_BUCKET_NAME:-sportsdesk-ops-reports}
R2_PUBLIC_URL=\${R2_PUBLIC_URL:-https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev}

# Telegram Bot Integration
TELEGRAM_BOT_TOKEN=\${BOT_TOKEN}
TELEGRAM_BOT_USERNAME=demodevdeskbot
TELEGRAM_MINIAPP_URL=https://\${DOMAIN}/miniapp
TELEGRAM_WEBHOOK_URL=https://\${DOMAIN}/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=\${WEBHOOK_SECRET}
TELEGRAM_ALERT_THRESHOLD_CENTS=500000
TELEGRAM_REPORT_SCHEDULE="0 8,13,23 * * *"
EOF
fi

chmod 600 "$APP_DIR/.env"

# The dashboard reads /api/* through Nginx, where the daemon cannot see a loopback peer, so it
# needs the admin token. Generate one when the copied .env does not carry one and print it once.
if ! grep -qE '^SPORTSDESK_ADMIN_TOKEN=.+' "$APP_DIR/.env"; then
  ADMIN_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    echo ""
    echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by deploy_to_vps.sh."
    echo "# Paste into the dashboard's Admin token field (Telegram panel); rotate by editing here."
    echo "SPORTSDESK_ADMIN_TOKEN=${ADMIN_TOKEN}"
  } >> "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo -e "      Admin token (shown once, stored in ${APP_DIR}/.env): ${BOLD}${ADMIN_TOKEN}${NC}"
fi

echo -e "      Production configuration saved to ${APP_DIR}/.env"

# Step 4: Configure and Enable Systemd Service
echo -e "${GREEN}[4/7] Configuring systemd daemon (${SERVICE_NAME}.service)...${NC}"
cat <<EOF > "/etc/systemd/system/${SERVICE_NAME}.service"
[Unit]
Description=SportsDesk & Fantasy402 Ops Daemon (supervisor: Webview + Blob/Live-Bets)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment="BUN_SOCKET=/run/sportsdesk/webview.sock"
# No SPORTSDESK_TRUST_PROXY here on purpose. The daemon sees the socket, not the client, so
# `requestIP()` is null for every request and it cannot tell a remote client from a local one;
# without the flag every `pii` route requires SPORTSDESK_ADMIN_TOKEN through the proxy, and the
# dashboard sends the token the operator pastes into its Admin token field. Set
# SPORTSDESK_TRUST_PROXY=1 only if you put your own auth in front of the domain (see auth_basic
# below) and accept that the daemon then trusts anybody the proxy forwards.
RuntimeDirectory=sportsdesk
RuntimeDirectoryMode=0755
ExecStart=${BUN_BIN} run services/supervisor.ts
Restart=always
RestartSec=5s
KillMode=process
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sportsdesk-ops

ProtectSystem=full
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo -e "      Service status: ${GREEN}${BOLD}ACTIVE (RUNNING)${NC}"
else
  echo -e "${RED}[WARNING] Service failed to start. Checking journalctl logs:${NC}"
  journalctl -u "${SERVICE_NAME}" -n 20 --no-pager
fi

# Step 5: Configure Nginx Reverse Proxy
echo -e "${GREEN}[5/7] Configuring Nginx reverse proxy for ${DOMAIN}...${NC}"
NGINX_SITE_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"

cat <<EOF > "$NGINX_SITE_CONF"
upstream sportsdesk_backend {
    server unix:/run/sportsdesk/webview.sock fail_timeout=0;
    server 127.0.0.1:${LOCAL_PORT} backup;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location = /telegram/webhook {
        proxy_pass http://sportsdesk_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Telegram-Bot-Api-Secret-Token \$http_x_telegram_bot_api_secret_token;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
        proxy_send_timeout 10s;
    }

    location / {
        proxy_pass http://sportsdesk_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;

        # Optional second layer: the daemon already requires SPORTSDESK_ADMIN_TOKEN on every pii
        # route, so this gates the pages and the operator's own dashboard too. Uncomment both
        # lines after `htpasswd -c /etc/nginx/.htpasswd <user>`, or put Cloudflare Access in front
        # of the host. Basic auth cannot be completed by Telegram, so leave /miniapp reachable if
        # you use the Mini App (it is static and fetches nothing).
        # auth_basic "SportsDesk";
        # auth_basic_user_file /etc/nginx/.htpasswd;

        # Content-Security-Policy allowing Telegram Mini App embedding
        add_header Content-Security-Policy "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;" always;
        add_header X-Content-Type-Options nosniff always;
    }
}
EOF

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/sites-enabled
ln -sf "$NGINX_SITE_CONF" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
nginx -t && systemctl reload nginx

# Step 6: Acquire Let's Encrypt SSL Certificate
echo -e "${GREEN}[6/7] Obtaining SSL certificate via Certbot for ${DOMAIN}...${NC}"
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>/dev/null; then
  echo -e "      ${GREEN}${BOLD}SSL Certificate successfully provisioned!${NC}"
else
  echo -e "${YELLOW}[NOTE] Certbot automated challenge skipped or failed (ensure DNS A-record points to this server IP).${NC}"
  echo -e "      Once DNS propagates, run: ${BOLD}certbot --nginx -d ${DOMAIN}${NC}"
fi

# Step 7: Register Telegram Webhook
echo -e "${GREEN}[7/7] Registering Telegram Bot Webhook with Telegram API...${NC}"
WEBHOOK_ENDPOINT="https://${DOMAIN}/telegram/webhook"

SET_RES=$(TELEGRAM_BOT_TOKEN="$BOT_TOKEN" TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET" TELEGRAM_WEBHOOK_ENDPOINT="$WEBHOOK_ENDPOINT" "$BUN_BIN" -e '
const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: process.env.TELEGRAM_WEBHOOK_ENDPOINT,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: true,
  }),
});
console.log(JSON.stringify(await res.json()));
')

echo -e "      Telegram Response: ${BOLD}${SET_RES}${NC}"

# Verification & Diagnostics
echo ""
echo -e "${CYAN}${BOLD}==============================================================================${NC}"
echo -e "${GREEN}${BOLD} 🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!${NC}"
echo -e "${CYAN}${BOLD}==============================================================================${NC}"
echo -e "• ${BOLD}Domain URL${NC}       : https://${DOMAIN}/"
echo -e "• ${BOLD}Telegram MiniApp${NC} : https://${DOMAIN}/miniapp"
echo -e "• ${BOLD}Telegram Webhook${NC} : https://${DOMAIN}/telegram/webhook"
echo -e "• ${BOLD}Healthcheck${NC}      : https://${DOMAIN}/health"
echo -e "• ${BOLD}Service Logs${NC}     : journalctl -u ${SERVICE_NAME} -f"
echo -e "• ${BOLD}Telegram Bot${NC}     : https://t.me/demodevdeskbot"
echo -e "${CYAN}==============================================================================${NC}"
