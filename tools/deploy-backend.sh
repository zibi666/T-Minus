#!/usr/bin/env bash
# TimeMark 后端部署：本地构建 → 上传 → 备份现役 jar → 重启 → 内外网健康检查。
#
# 需要你亲自跑：本会话的权限层不允许我对生产服务器发起 SSH/远程执行。
# 前提：能免密 ssh root@118.195.133.25（或把 HOST/USER 改成你的部署账号）。
#
# 用法：
#   bash tools/deploy-backend.sh              # 构建 + 部署
#   bash tools/deploy-backend.sh --skip-build # 用现成的 backend/target/timemark-server.jar 直接部署
set -euo pipefail

HOST="${TIMEMARK_SSH_HOST:-root@118.195.133.25}"
APP_DIR="${TIMEMARK_APP_DIR:-/opt/timemark}"
JAR_NAME="${TIMEMARK_JAR_NAME:-timemark-server.jar}"
PORT="${TIMEMARK_PORT:-18080}"
UNIT=timemark.service

cd "$(git rev-parse --show-toplevel)"
LOCAL_JAR="backend/target/$JAR_NAME"

if [ "${1:-}" != "--skip-build" ]; then
  echo "== 1/5 构建（jar 被运行中的本地 java 进程占用时会失败，先停本地服务）=="
  (cd backend && mvn -s .mvn-settings.xml -q -DskipTests package)
fi
[ -f "$LOCAL_JAR" ] || { echo "找不到 $LOCAL_JAR，先不带 --skip-build 跑一次"; exit 1; }

LOCAL_MD5=$(md5sum "$LOCAL_JAR" | cut -d' ' -f1)
echo "本地 jar: $LOCAL_JAR  md5=$LOCAL_MD5  大小=$(du -h "$LOCAL_JAR" | cut -f1)"

echo "== 2/5 连通性与现役版本 =="
ssh -o ConnectTimeout=12 -o BatchMode=yes "$HOST" \
  "systemctl is-active $UNIT; md5sum $APP_DIR/$JAR_NAME 2>/dev/null | cut -d' ' -f1 || echo '现役 jar 不存在'"

echo "== 3/5 上传为 .new（不直接覆盖，留出回滚点）=="
scp -q -o ConnectTimeout=20 "$LOCAL_JAR" "$HOST:$APP_DIR/$JAR_NAME.new"

echo "== 4/5 现役备份 + 换装 + 重启 =="
ssh -o BatchMode=yes "$HOST" "set -e
  cd $APP_DIR
  if [ -f $JAR_NAME ]; then cp -f $JAR_NAME $JAR_NAME.prev.\$(date +%Y%m%d-%H%M%S); fi
  mv -f $JAR_NAME.new $JAR_NAME
  sudo systemctl restart $UNIT
  sleep 6
  systemctl is-active $UNIT
  curl -s -m 8 http://127.0.0.1:$PORT/api/v1/health || { echo '本机健康检查失败'; exit 1; }
  echo
  ls -1t $JAR_NAME.prev.* 2>/dev/null | tail -n +4 | xargs -r rm -f   # 只留最近 3 份备份
"

echo "== 5/5 公网健康检查 =="
curl -s -m 12 "http://118.195.133.25:$PORT/api/v1/health" && echo "  <- 公网可达"

echo
echo "部署完成。回滚：ssh $HOST 'cd $APP_DIR && ls -1t $JAR_NAME.prev.* | head -1 | xargs -I{} mv -f {} $JAR_NAME && sudo systemctl restart $UNIT'"
echo
echo "注意：本轮客户端改动不需要后端变更（Java 代码零改动，新 record_type 取值服务端不解释）；"
echo "     这个 jar 与现役的唯一差别是多了 TIMEMARK_SERVER_ADDRESS 开关（上 HTTPS 时用它绑 127.0.0.1）。"
