# TimeMark 同步服务 HTTPS 部署指南

> ## ✅ 部署状态：已上线（2026-09-19）
>
> HTTPS 已在生产服务器部署完成并验证通过，`https://sync.knowhub.chat:18443` 公网可访问。
>
> **实际落地配置**（与下方指南一致，补充几个实测细节）：
> - 服务器：腾讯云 CVM，Ubuntu 22.04，**nginx 1.18**，后端 Spring Boot 在 `127.0.0.1:18080`（健康）
> - 证书：Let's Encrypt **ECC** 证书，`CN=sync.knowhub.chat`，有效期 2026-09-19 ~ 2026-12-18
> - 证书路径：`/etc/nginx/ssl/sync.knowhub.chat/{fullchain.cer,sync.knowhub.chat.key}`
> - acme.sh 装在 `/root/.acme.sh`，root cron 每天 07:25 检查，约 10-18 自动续期并 reload nginx
> - nginx 站点配置：`/etc/nginx/conf.d/timemark.conf`（监听 18443，limit_req zone 用唯一名 `tm_auth`/`tm_sync` 避免与同机其它站点冲突）
>
> **部署时踩到的三个坑（已在 `setup-https.sh` 修复，重跑不会再犯）**：
> 1. **acme.sh 从 GitHub 下载被大陆网络重置** → 改用 Gitee 镜像 `git clone https://gitee.com/neilpang/acme.sh.git` 安装。
> 2. **acme.sh 调 Cloudflare API 报 curl error 92（HTTP/2 流重置）** → 写 `/root/.curlrc` 内容 `--http1.1` 强制 HTTP/1.1；此文件对续期 cron 同样生效。
> 3. **nginx 1.18 不认 `http2 on;`（那是 1.25.1+ 新语法）** → 配置里不写该行（本同步 API 载荷小，HTTP/1.1 足够）。
>
> **验证命令**：
> ```bash
> curl -s https://sync.knowhub.chat:18443/api/v1/health   # {"ok":true,"app":"TimeMark Sync",...}
> ```
>
> **⚠️ 安全待办**：本次部署用的 Cloudflare API Token 曾出现在聊天记录里，应视为已泄露。
> 建议去 Cloudflare 轮换（Roll）该 Token，然后在服务器上更新存储的副本（否则 60 天后续期会失败）：
> ```bash
> # SSH 上服务器后，用新 Token 替换 account.conf 里的旧值（新旧 Token 都别贴进聊天）
> sudo sed -i "s|^SAVED_CF_Token=.*|SAVED_CF_Token='新Token'|" /root/.acme.sh/account.conf
> # 然后去 Cloudflare 把旧 Token 作废
> ```

---

## 架构与设计
```
客户端 → https://sync.knowhub.chat:18443
         ↓ Cloudflare DNS（灰云，仅解析）
       118.195.133.25:18443
         ↓ nginx TLS 终结（Let's Encrypt 证书）
       127.0.0.1:18080（TimeMark Spring Boot）
```

**关键设计**：
- 使用 **18443 非标端口**：腾讯云只拦截 80/443/8080 的未备案域名，18443 不受影响
- 使用 **Let's Encrypt + DNS-01 验证**：无需 HTTP 端口，完全绕开备案
- 使用 **Cloudflare DNS（灰云）**：只做解析，不走 CDN 代理，国内访问速度 = 直连 IP
- 客户端 **零配置**：Let's Encrypt 是公信 CA，三端系统内置信任链

---

## 第 1 节：Cloudflare DNS 配置

### 1.1 添加 A 记录

登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 选择 `knowhub.chat` → DNS：

| Type | Name | Content | Proxy status | TTL |
|------|------|---------|--------------|-----|
| A | `sync` | `118.195.133.25` | **DNS only（灰云）** | Auto |

⚠️ **必须是灰云（DNS only）**，不能是橙云（Proxied）。橙云会走 Cloudflare CDN，国内访问极慢且免费版 IP 经常被墙。

### 1.2 创建 API Token（用于 acme.sh 自动续证）

Cloudflare Dashboard → 右上角头像 → **My Profile** → **API Tokens** → **Create Token**：

1. 使用模板 **"Edit zone DNS"**
2. 权限：`Zone → DNS → Edit`
3. Zone Resources：`Include → Specific zone → knowhub.chat`
4. 继续创建，**复制生成的 Token**（只显示一次！）

把 Token 保存到安全的地方，下一步要用。

---

## 第 2 节：服务器部署（在 118.195.133.25 上执行）

### 2.1 安装 acme.sh

```bash
# 安装 acme.sh（Let's Encrypt 客户端，比 certbot 更轻量）
curl https://get.acme.sh | sh -s email=your-email@example.com

# 让 acme.sh 命令生效
source ~/.bashrc

# 设置默认 CA 为 Let's Encrypt（acme.sh 默认用 ZeroSSL）
acme.sh --set-default-ca --server letsencrypt
```

### 2.2 配置 Cloudflare API Token

```bash
# 把第 1.2 节创建的 Token 写入环境变量
export CF_Token="你的_Cloudflare_API_Token"

# 永久保存（acme.sh 续证时会自动读取）
echo 'export CF_Token="你的_Cloudflare_API_Token"' >> ~/.bashrc
source ~/.bashrc
```

### 2.3 签发证书

```bash
# 用 DNS-01 验证签发证书（自动在 Cloudflare 加 TXT 记录，验证后自动删除）
acme.sh --issue --dns dns_cf -d sync.knowhub.chat

# 证书会保存在 ~/.acme.sh/sync.knowhub.chat/
ls -la ~/.acme.sh/sync.knowhub.chat/
```

### 2.4 安装证书到 nginx 目录

```bash
# 创建 nginx 证书目录
sudo mkdir -p /etc/nginx/ssl/sync.knowhub.chat

# 安装证书 + 配置自动续期后 reload nginx
acme.sh --install-cert -d sync.knowhub.chat \
  --key-file       /etc/nginx/ssl/sync.knowhub.chat/sync.knowhub.chat.key \
  --fullchain-file /etc/nginx/ssl/sync.knowhub.chat/fullchain.cer \
  --reloadcmd      "sudo systemctl reload nginx"

# 验证文件权限（nginx 需要能读取）
sudo ls -la /etc/nginx/ssl/sync.knowhub.chat/
sudo chmod 644 /etc/nginx/ssl/sync.knowhub.chat/fullchain.cer
sudo chmod 600 /etc/nginx/ssl/sync.knowhub.chat/sync.knowhub.chat.key
```

### 2.5 部署 nginx 配置

```bash
# 复制仓库里的 nginx 配置
sudo cp deploy/nginx-timemark.conf /etc/nginx/conf.d/timemark.conf

# 测试配置语法
sudo nginx -t

# 重载 nginx
sudo systemctl reload nginx
```

### 2.6 放行 18443 端口（腾讯云安全组）

登录 [腾讯云控制台](https://console.cloud.tencent.com/) → 云服务器 → 安全组：

- 入站规则：添加 `TCP:18443`，来源 `0.0.0.0/0`，策略 `允许`

### 2.7 后端仅监听回环（可选但推荐）

```bash
# 编辑 systemd 服务
sudo systemctl edit timemark

# 加入以下内容（如果 application.yml 已支持 TIMEMARK_SERVER_ADDRESS 环境变量）
[Service]
Environment=TIMEMARK_SERVER_ADDRESS=127.0.0.1

# 重启并验证
sudo systemctl restart timemark
ss -lntp | grep 18080    # 期望 127.0.0.1:18080，而不是 0.0.0.0:18080
```

> 如果 `application.yml` 没有 `server.address` 配置项，需先添加：
> ```yaml
> server:
>   address: ${TIMEMARK_SERVER_ADDRESS:0.0.0.0}
> ```

---

## 第 3 节：验证部署

### 3.1 本地验证（服务器上）

```bash
# 健康检查
curl -s https://sync.knowhub.chat:18443/api/v1/health
# 期望：{"ok":true,"app":"TimeMark Sync","time":...}

# 证书信息
echo | openssl s_client -connect sync.knowhub.chat:18443 -servername sync.knowhub.chat 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
# 期望：issuer 包含 Let's Encrypt，有效期 90 天
```

### 3.2 远程验证（你的电脑上）

```bash
# Windows PowerShell
curl.exe -s https://sync.knowhub.chat:18443/api/v1/health

# 或浏览器直接访问
# https://sync.knowhub.chat:18443/api/v1/health
# 应该看到 JSON 响应，且地址栏显示锁图标（证书有效）
```

### 3.3 客户端验证

重新构建三端并测试登录/同步：
- Windows：应用日志不应出现 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- Android：不应报 `SSLHandshakeException`
- Harmony：不应报 TLS 错误（2300997/2300998）

---

## 第 4 节：自动续期（已配置，无需手动操作）

acme.sh 安装时已自动添加 crontab：

```bash
# 查看定时任务
crontab -l
# 期望看到：0 0 * * * "/home/你的用户名/.acme.sh"/acme.sh --cron --home "/home/你的用户名/.acme.sh" > /dev/null
```

- Let's Encrypt 证书有效期 90 天
- acme.sh 每 60 天自动续期
- 续期后自动执行 `--reloadcmd`（reload nginx）
- **完全无需人工干预**

手动测试续期（可选）：
```bash
acme.sh --renew -d sync.knowhub.chat --force
```

---

## 第 5 节：故障排查

### 5.1 证书签发失败

```bash
# 查看 acme.sh 日志
cat ~/.acme.sh/acme.sh.log | tail -50

# 常见原因：
# 1. CF_Token 未设置或无效 → 重新 export CF_Token="..."
# 2. Cloudflare DNS 记录未生效 → 等 1-2 分钟或检查灰云状态
# 3. Let's Encrypt 速率限制 → 等 1 小时或换 staging 环境测试
```

### 5.2 nginx 启动失败

```bash
# 检查配置语法
sudo nginx -t

# 查看错误日志
sudo tail -50 /var/log/nginx/error.log

# 常见原因：
# 1. 证书路径错误 → 检查 /etc/nginx/ssl/sync.knowhub.chat/ 是否存在
# 2. 18443 端口被占用 → sudo ss -lntp | grep 18443
# 3. 权限问题 → sudo chmod 644 fullchain.cer && sudo chmod 600 *.key
```

### 5.3 客户端无法连接

```bash
# 1. 检查 DNS 解析
nslookup sync.knowhub.chat
# 期望：118.195.133.25

# 2. 检查端口连通性
telnet sync.knowhub.chat 18443
# 或
Test-NetConnection sync.knowhub.chat -Port 18443

# 3. 检查腾讯云安全组是否放行 18443

# 4. 检查 nginx 是否监听
sudo ss -lntp | grep 18443
```

---

## 第 6 节：未来迁移（可选）

### 6.1 如果未来域名备案了

可以把服务迁移到 443 端口，客户端 URL 去掉 `:18443`：

```bash
# 修改 nginx 配置
sudo sed -i 's/listen 18443 ssl;/listen 443 ssl;/g' /etc/nginx/conf.d/timemark.conf
sudo sed -i 's/listen \[::\]:18443 ssl;/listen [::]:443 ssl;/g' /etc/nginx/conf.d/timemark.conf
sudo nginx -t && sudo systemctl reload nginx

# 更新三端 URL 常量（去掉 :18443）
# Windows: apps/windows/electron/syncClient.ts
# Android: apps/android/.../data/AppContainer.kt
# Harmony: apps/harmony/.../data/AuthStore.ets
```

### 6.2 如果换服务器/换 IP

只需在 Cloudflare 改 A 记录，等 DNS 生效（通常 1-5 分钟），客户端无需任何改动。

### 6.3 如果换域名

```bash
# 1. Cloudflare 加新域名的 A 记录
# 2. 服务器上签发新证书
acme.sh --issue --dns dns_cf -d newsync.example.com
acme.sh --install-cert -d newsync.example.com \
  --key-file       /etc/nginx/ssl/newsync.example.com/newsync.example.com.key \
  --fullchain-file /etc/nginx/ssl/newsync.example.com/fullchain.cer \
  --reloadcmd      "sudo systemctl reload nginx"

# 3. 修改 nginx 配置里的 server_name 和证书路径
# 4. 更新三端 URL 常量
# 5. 重新构建三端
```

---

## 附录：运维检查清单

- [ ] Cloudflare DNS A 记录 `sync` → `118.195.133.25`（灰云）
- [ ] Cloudflare API Token 已创建并保存到服务器 `~/.bashrc`
- [ ] acme.sh 已安装并签发证书
- [ ] 证书已安装到 `/etc/nginx/ssl/sync.knowhub.chat/`
- [ ] nginx 配置已部署并 reload
- [ ] 腾讯云安全组放行 18443/TCP
- [ ] 后端监听 127.0.0.1:18080（可选）
- [ ] `curl https://sync.knowhub.chat:18443/api/v1/health` 返回 200
- [ ] 三端客户端登录/同步正常
- [ ] crontab 里有 acme.sh 自动续期任务

---

## 回滚方案（应急）

如果 HTTPS 部署后出现严重问题，可临时回滚到 HTTP：

```bash
# 1. 停止 nginx
sudo systemctl stop nginx

# 2. 后端改回监听 0.0.0.0
sudo systemctl edit timemark    # 删除 TIMEMARK_SERVER_ADDRESS 或改为 0.0.0.0
sudo systemctl restart timemark

# 3. 三端 URL 改回 http://118.195.133.25:18080
# Windows: apps/windows/electron/syncClient.ts
# Android: apps/android/.../data/AppContainer.kt
# Harmony: apps/harmony/.../data/AuthStore.ets

# 4. Android 还原 network_security_config.xml 允许明文
# 5. 重新构建三端
```

**注意**：回滚后数据再次以明文传输，仅作为应急手段。
