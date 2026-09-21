# TimeMark 同步后端（Spring Boot 3 + MySQL）

实现《开发计划 v2》§5 同步协议契约，与三端客户端直接对接。
API 与已移除的本地开发版（`server/`，Node）完全一致，客户端切换服务器地址即可，无感迁移。

**对外地址是 `https://sync.knowhub.chat:18443`（nginx 反代 + Let's Encrypt）**，后端本身只听回环。部署/迁移/回滚见 [`../deploy/TLS-CUTOVER.md`](../deploy/TLS-CUTOVER.md) 与 `../deploy/setup-https.sh`。

## 1. 数据库准备（腾讯云 TDSQL-C MySQL）

- 主机：`sh-cynosdbmysql-grp-2gf1ewak.sql.tencentcdb.com:28451`
- **安全组**：放行你的服务器 IP 访问 28451 端口
- 建库：执行 `init-sql.sql`（创建 `timemark` 库，utf8mb4）；表结构由后端首次启动自动创建
- 记下账号密码（下文 `TIMEMARK_DB_USER` / `TIMEMARK_DB_PASSWORD`）

## 2. 配置（全部走环境变量，不写死任何密钥）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TIMEMARK_DB_URL` | JDBC 连接串，**库名必须与建库一致** | `jdbc:mysql://sh-cynosdbmysql-grp-2gf1ewak.sql.tencentcdb.com:28451/timemark?useUnicode=true&characterEncoding=utf8&serverTimezone=UTC&useSSL=false&allowPublicKeyRetrieval=true` |
| `TIMEMARK_DB_USER` | 数据库账号 | `root` |
| `TIMEMARK_DB_PASSWORD` | 数据库密码 | 无默认，**必填** |
| `TIMEMARK_JWT_SECRET` | JWT 签名密钥 | 不填则首次启动自动生成并存入 meta 表 |
| `TIMEMARK_SERVER_PORT` | 监听端口 | `18080` |

> 端口默认值已从 8080 改为 18080：目标服务器 8080 被其他业务占用。
> 生产环境后端只绑 `127.0.0.1`，由 nginx 反代并终止 TLS，不要把 18080 暴露到公网。
>
> 若 TDSQL-C 强制 SSL，把 URL 中 `useSSL=false` 改为 `useSSL=true&sslMode=REQUIRED` 并按腾讯云文档配置证书。

## 3. 构建与部署

### 方式 A：裸 JVM（推荐，最简单）

```bash
# 本机（或任意有 JDK17+Maven 的机器）构建：
cd backend
mvn -s .mvn-settings.xml -DskipTests package
# 产物：target/timemark-server.jar

# 服务器上（仅需 JRE 17+）：
TIMEMARK_DB_PASSWORD='你的数据库密码' \
java -jar timemark-server.jar
```

systemd 单元示例 `/etc/systemd/system/timemark.service`：

```ini
[Unit]
Description=TimeMark Sync Server
After=network.target

[Service]
Environment=TIMEMARK_DB_PASSWORD=你的数据库密码
Environment=TIMEMARK_SERVER_PORT=18080
ExecStart=/usr/bin/java -Xms128m -Xmx256m -jar /opt/timemark/timemark-server.jar
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now timemark`

### 方式 B：Docker

```bash
cd backend
# 先构建好 target/timemark-server.jar
echo "TIMEMARK_DB_PASSWORD=你的数据库密码" > .env
docker compose up -d --build
```

## 4. 验证

```bash
# 服务器本机（后端只听回环）
curl http://127.0.0.1:18080/api/v1/health
# {"ok":true,"app":"TimeMark Sync","time":...}

# 经 nginx 的对外地址
curl https://sync.knowhub.chat:18443/api/v1/health
```

- 客户端登录框「同步服务器」已内置该地址，无需手工填写。
- 安全组需放行 **18443**（80/443 被腾讯云对未备案域名拦截，故用非标端口）。

## 4.1 4xx 行为（客户端依赖这些口径）

| 场景 | 响应 |
|---|---|
| 注册/登录凭据超长（username > 64 或口令 > 72 字节） | 400 / 401 `bad_credentials`——BCrypt 对超 72 字节口令会抛异常，必须前置拦 |
| 请求体不是合法 JSON | 400 `bad_request` |
| 路径参数类型不匹配 | 400 `bad_request` |
| push 的 `operations` 非数组 / 元素非对象 | 400 `bad_request` |
| 同名账号并发注册 | 409 |

push 的**单条失败不再降级成 `rejected`**：异常一律冒泡走 5xx，客户端保留整批队列下轮重投，已提交条目由 `ops` 幂等表返回 `duplicate: true` 收敛。客户端只把终态（accepted/conflict/discarded/bad_request/duplicate）结果出队。

## 5. API 一览（与客户端契约）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/v1/health | 健康检查 |
| POST | /api/v1/auth/register | 注册并返回 token |
| POST | /api/v1/auth/login | 登录并返回 token |
| GET | /api/v1/me | 校验 token（Bearer） |
| GET | /api/v1/sync/pull?cursor=&limit= | 增量拉取（change_seq 游标，**仅整页连续前缀被消费完才推进**） |
| POST | /api/v1/sync/push | 批量上传（逐条事务 + 用户行锁；operation_id 幂等 / base_version 冲突校验 / 墓碑） |

## 5.1 索引

`schema.sql` 为 `change_log` 内联声明了复合索引 `idx_change_user (user_id, change_seq)`——pull 恒按该组合过滤，缺索引会全表扫描。**内联索引只对首次建表生效**，存量库需手动补齐：

```sql
ALTER TABLE change_log ADD INDEX idx_change_user (user_id, change_seq);
```

## 6. 与本地开发版（`server/`）的关系

- 两版 API 契约一致，但**数据不互通**（各自独立库）。
- Node 开发版已连同本机 SDK / 构建产物一起从**全部历史**中移除（2026-09-21 filter-repo 瘦身，见 `docs/TimeMark-进度与待办-2026-09-21.md` §4.1），正式多端使用以本目录（Spring Boot + 云 MySQL）为唯一后端。
