#!/usr/bin/env bash
# ============================================================================
# TimeMark HTTPS 一键部署脚本
#   域名: sync.knowhub.chat  端口: 18443  后端: 127.0.0.1:18080
#   证书: Let's Encrypt（acme.sh + Cloudflare DNS-01）
#
# 用法（在服务器 118.195.133.25 上执行）：
#   1. 先把本脚本传到服务器（或在服务器上 git pull 仓库）
#   2. export CF_Token="你的Cloudflare_API_Token"     # 不要写进脚本！
#   3. export ACME_EMAIL="你的邮箱@example.com"        # Let's Encrypt 到期提醒用
#   4. sudo -E bash deploy/setup-https.sh             # -E 保留环境变量传给 root
#
# 脚本是幂等的：重复运行会跳过已完成的步骤。
# ============================================================================
set -euo pipefail

DOMAIN="sync.knowhub.chat"
PORT="18443"
BACKEND="127.0.0.1:18080"
CERT_DIR="/etc/nginx/ssl/${DOMAIN}"
# 固定绝对路径：脚本经 sudo 以 root 运行，避免 sudo -E 下 HOME 可能是 /home/ubuntu 或 /root 的歧义
ACME_DIR="/root/.acme.sh"
ACME="${ACME_DIR}/acme.sh"
NGINX_CONF="/etc/nginx/conf.d/timemark.conf"

log()  { echo -e "\033[1;32m[+]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
die()  { echo -e "\033[1;31m[x]\033[0m $*" >&2; exit 1; }

# ---- 前置检查 ---------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo -E bash $0"
# 强制 HOME=/root：脚本经 sudo -E 运行时 HOME 可能保留为 /home/普通用户，
# 会导致 acme.sh 的 account.conf 写到错误位置（--set-default-ca 不生效→回退 ZeroSSL 失败）
export HOME=/root
[ -n "${CF_Token:-}" ] || die "未设置 CF_Token 环境变量。先执行：export CF_Token=\"你的Token\"（并用 sudo -E 保留）"
[ -n "${ACME_EMAIL:-}" ] || die "未设置 ACME_EMAIL 环境变量。先执行：export ACME_EMAIL=\"你的邮箱\""

log "开始部署 HTTPS：${DOMAIN}:${PORT} → ${BACKEND}"

# ---- 1. 安装依赖 ------------------------------------------------------------
log "检查依赖 (curl / openssl / nginx / git)..."
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  for pkg in curl openssl nginx git; do
    command -v "$pkg" >/dev/null 2>&1 || { log "安装 $pkg"; apt-get install -y -qq "$pkg"; }
  done
else
  warn "非 Debian/Ubuntu 系统，请自行确保 curl/openssl/nginx/git 已安装"
fi

# ---- 2. 安装 acme.sh（Gitee 镜像优先，中国大陆网络 GitHub 常被重置）----
if [ ! -f "$ACME" ]; then
  log "从镜像安装 acme.sh..."
  TMP_SRC=$(mktemp -d)
  # 优先 Gitee（国内可达），失败回退 GitHub
  git clone --depth 1 https://gitee.com/neilpang/acme.sh.git "${TMP_SRC}/acme.sh" 2>/dev/null || \
    git clone --depth 1 https://github.com/acmesh-official/acme.sh.git "${TMP_SRC}/acme.sh" || \
    die "acme.sh 源码下载失败（Gitee 与 GitHub 都不可达）"
  ( cd "${TMP_SRC}/acme.sh" && ./acme.sh --install -m "${ACME_EMAIL}" --home "$ACME_DIR" ) || \
    die "acme.sh 安装失败"
  rm -rf "$TMP_SRC"
else
  log "acme.sh 已存在，跳过安装"
fi
[ -f "$ACME" ] || die "acme.sh 安装失败"

log "设置默认 CA 为 Let's Encrypt..."
"$ACME" --set-default-ca --server letsencrypt

# ---- 3. 签发证书 ------------------------------------------------------------
# 中国大陆连 api.cloudflare.com 常遇 HTTP/2 流重置(curl error 92)：强制 root 的 curl 走 HTTP/1.1。
# acme.sh 签发与后续 cron 续期都以 root + HOME=/root 运行，会读取 /root/.curlrc，因此续期也一并修复。
echo "--http1.1" > /root/.curlrc

if [ -f "${ACME_DIR}/${DOMAIN}/${DOMAIN}.cer" ] || [ -f "${ACME_DIR}/${DOMAIN}_ecc/${DOMAIN}.cer" ]; then
  log "证书已存在，尝试续期（若未到续期窗口会自动跳过）..."
  "$ACME" --renew -d "${DOMAIN}" --force || warn "续期失败，沿用现有证书"
else
  log "用 Cloudflare DNS-01 签发证书（RSA，自动加/删 TXT 记录）..."
  ok=0
  for attempt in 1 2 3 4; do
    log "签发尝试 ${attempt}/4 ..."
    if "$ACME" --issue --server letsencrypt --dns dns_cf -d "${DOMAIN}"; then ok=1; break; fi
    warn "第 ${attempt} 次签发失败（多为大陆→Cloudflare API 网络抖动），5s 后重试"
    sleep 5
  done
  [ "$ok" = "1" ] || die "证书签发失败（重试 4 次仍不通）。若为网络抖动，稍后重跑本脚本即可；也请确认 CF_Token 有效、DNS 为灰云"
fi

# ---- 4. 安装证书到 nginx 目录 ----------------------------------------------
log "安装证书到 ${CERT_DIR}..."
mkdir -p "${CERT_DIR}"
"$ACME" --install-cert -d "${DOMAIN}" \
  --key-file       "${CERT_DIR}/${DOMAIN}.key" \
  --fullchain-file "${CERT_DIR}/fullchain.cer" \
  --reloadcmd      "systemctl reload nginx"
chmod 644 "${CERT_DIR}/fullchain.cer"
chmod 600 "${CERT_DIR}/${DOMAIN}.key"

# ---- 5. 写 nginx 配置 -------------------------------------------------------
log "写入 nginx 配置 ${NGINX_CONF}..."
# 用唯一 zone 名（tm_auth/tm_sync）避免与机器上其它站点（如 443 上的无关域名）的 limit_req_zone 重名冲突
cat > "${NGINX_CONF}" <<NGINX_EOF
# TimeMark 同步服务 —— 由 deploy/setup-https.sh 自动生成
# 监听 ${PORT}（非标端口，避开腾讯云未备案域名拦截）；证书由 acme.sh 自动续期
limit_req_zone \$binary_remote_addr zone=tm_auth:10m rate=5r/m;
limit_req_zone \$binary_remote_addr zone=tm_sync:10m rate=60r/m;

server {
    listen ${PORT} ssl;
    listen [::]:${PORT} ssl;
    server_name ${DOMAIN};

    ssl_certificate     ${CERT_DIR}/fullchain.cer;
    ssl_certificate_key ${CERT_DIR}/${DOMAIN}.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:TMSSL:10m;
    ssl_session_timeout 10m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip off;
    client_max_body_size 2m;

    location /api/v1/auth/ {
        limit_req zone=tm_auth burst=5 nodelay;
        proxy_pass http://${BACKEND};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    location /api/ {
        limit_req zone=tm_sync burst=120 nodelay;
        proxy_pass http://${BACKEND};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    location = /api/v1/health {
        proxy_pass http://${BACKEND};
        access_log off;
    }

    location / { return 404; }

    access_log /var/log/nginx/timemark-access.log;
    error_log  /var/log/nginx/timemark-error.log;
}
NGINX_EOF

# ---- 6. 测试并重载 nginx ----------------------------------------------------
log "测试 nginx 配置..."
nginx -t || die "nginx 配置测试失败，请检查 ${NGINX_CONF}"
log "重载 nginx..."
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx

# ---- 7. 验证 ----------------------------------------------------------------
log "本地验证 HTTPS..."
sleep 1
if curl -fsS "https://${DOMAIN}:${PORT}/api/v1/health" >/dev/null 2>&1; then
  log "✅ 部署成功！健康检查通过："
  curl -fsS "https://${DOMAIN}:${PORT}/api/v1/health"; echo
else
  warn "本机 curl 验证未通过（可能是 DNS 未生效或安全组未放行 ${PORT}）"
  warn "请在腾讯云安全组放行 TCP:${PORT}，并在本地等 DNS 生效后重试："
  warn "  curl https://${DOMAIN}:${PORT}/api/v1/health"
fi

cat <<DONE

============================================================
 部署完成！后续检查：
 1. 腾讯云安全组放行入站 TCP:${PORT}
 2. 本地验证： curl https://${DOMAIN}:${PORT}/api/v1/health
 3. 自动续期已配置（acme.sh crontab，每 60 天自动续）：
      crontab -l | grep acme
 4. 证书到期时间：
      echo | openssl s_client -connect ${DOMAIN}:${PORT} 2>/dev/null | openssl x509 -noout -dates
============================================================
DONE
