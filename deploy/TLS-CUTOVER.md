 # TimeMark 同步服务 HTTPS 改造（服务端侧，需你在 118.195.133.25 上执行）

现状：客户端与服务端之间是**明文 HTTP**（`http://118.195.133.25:18080`）。
用户名/密码、JWT、以及全部用户数据都以明文过网。任何一跳（同机房、运营商、公共 WiFi）都能读到。

这一目录里的东西把风险关掉，且**不改动后端 Java 代码**：TLS 由反代终结，后端继续听 127.0.0.1。

---

## 0. 先选一条路

| 方案 | 前提 | 客户端改动 | 推荐度 |
| --- | --- | --- | --- |
| A. 域名 + Let's Encrypt | 你有一个能用 TXT/A 记录解析的域名 | 只改一个常量 | ★★★ 首选 |
| B. 自签根 CA（Caddy `tls internal`） | 无域名，只有裸 IP | 需把根 CA 打进两端安装包 | ★★ 兜底 |

裸 IP 拿不到公网可信证书（Let's Encrypt 不给 IP 签发；`198.20.x` 类 IP 证书不适用）。
所以只有上面两条。若你愿意花 30 秒，选 A。

---

## 1. 方案 A：域名 + certbot + nginx

前提：把 `sync.example.com` 的 A 记录指到 `118.195.133.25`，且安全组放行 80/443。

```bash
sudo apt-get update && sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-timemark.conf /etc/nginx/conf.d/timemark.conf
# 把文件里的 sync.example.com 全部换成你的域名
sudo sed -i 's/sync\.example\.com/你的域名/g' /etc/nginx/conf.d/timemark.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名 --redirect -n --agree-tos -m 你的邮箱
```

后端必须只监听回环（现在听 0.0.0.0:18080 的话，明文口仍对外暴露）：

```bash
sudo systemctl edit timemark        # 加入下面两行
# [Service]
# Environment=TIMEMARK_DB_URL=jdbc:mysql://... （保持原样）
# Environment=SERVER_ADDRESS=127.0.0.1
sudo systemctl restart timemark
ss -lntp | grep 18080               # 期望 127.0.0.1:18080，而不是 0.0.0.0:18080
curl -s http://127.0.0.1:18080/api/v1/health
```

> Spring Boot 用 `server.address=127.0.0.1` 才绑回环；若 systemd unit 没有传该参数，
> 直接在 `application.yml` 里加 `server.address: ${TIMEMARK_SERVER_ADDRESS:0.0.0.0}`，
> 再由 systemd 注入 `TIMEMARK_SERVER_ADDRESS=127.0.0.1`。仓库里已加该开关，默认值不变，线上行为不受影响。

## 2. 方案 B：Caddy 内部 CA

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo cp deploy/Caddyfile-ip /etc/caddy/Caddyfile
sudo systemctl restart caddy
# 导出根 CA，交给客户端打包用
sudo cp /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt /tmp/timemark-ca.pem
```

客户端要把 `/tmp/timemark-ca.pem` 放进：
- Android：`app/src/main/res/raw/timemark_ca.pem`（`network_security_config.xml` 里已预留 `@raw/timemark_ca`，注释状态）
- Windows：`assets/ca/timemark-ca.pem`（`main.ts` 启动时若发现该文件会自动设 `NODE_EXTRA_CA_CERTS`，已实现）

注意：内部 CA 的根证书一旦轮换，所有已装客户端都要跟着更新 —— 这是没有域名的代价。

## 3. 客户端切换（服务端就绪后再做，两步，都是改常量）

1. `apps/windows/electron/syncClient.ts` → `DEFAULT_SERVER = 'https://...'`
2. `apps/android/.../data/AppContainer.kt` → `SERVER_URL = 'https://.../'`
3. `apps/windows/electron/main.ts` → `UPDATE_SOURCES` 不涉及，无需改
4. Android 的 `network_security_config.xml` 删掉 `cleartextTrafficPermitted` 那段（切完就再无明文）
5. `apps/windows/src/renderer/App.tsx` 里的 `SYNC_SERVER` 常量已是死代码，删除

## 4. 顺手要做的两件运维项

- 云数据库 root 密码仍在 `docs/TimeMark-进度与待办-2026-09-16.md` 待办里没改（密码在对话里出现过多次）。
  腾讯云控制台改密后：`sudo systemctl edit timemark` 更新 `TIMEMARK_DB_PASSWORD` → `sudo systemctl restart timemark`。
- 生产库里还留着验证数据：`probe_user_x9` 用户名下有个 `SmokeTest` 计时器（同一份待办里记着）。
  清理：`DELETE FROM timer_item WHERE name='SmokeTest'; DELETE FROM users WHERE username='probe_user_x9';`
- 注册接口无任何速率/验证码限制，`/api/v1/auth/register` 可被脚本刷。反代加一条：
  `location /api/v1/auth/ { limit_req zone=auth burst=5 nodelay; ... }`（nginx 配置里已给）。
