# TimeMark 同步后端（Spring Boot 3 + MySQL）

实现《开发计划 v2》§5 同步协议契约，与 Windows 客户端直接对接。
API 与本地开发版（`server/`，Node）完全一致，客户端切换服务器地址即可，无感迁移。

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
| `TIMEMARK_SERVER_PORT` | HTTP 端口 | `8080` |

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
ExecStart=/usr/bin/java -Xms128m -Xmx512m -jar /opt/timemark/timemark-server.jar
Restart=always
User=timemark

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
curl http://127.0.0.1:8080/api/v1/health
# {"ok":true,"app":"TimeMark Sync","time":...}
```

- 服务器防火墙/安全组放行 8080（或用 Nginx 反代 + HTTPS）
- Windows 客户端登录框「同步服务器」填：`http://服务器IP:8080`，注册即用

## 5. API 一览（与客户端契约）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/v1/health | 健康检查 |
| POST | /api/v1/auth/register | 注册并返回 token |
| POST | /api/v1/auth/login | 登录并返回 token |
| GET | /api/v1/me | 校验 token（Bearer） |
| GET | /api/v1/sync/pull?cursor=&limit= | 增量拉取（change_seq 游标） |
| POST | /api/v1/sync/push | 批量上传（operation_id 幂等 / base_version 冲突校验 / 墓碑） |

## 6. 与本地开发版（`server/`）的关系

- 两版 API 契约一致，但**数据不互通**（各自独立库）
- 正式多端使用以本目录（Spring Boot + 你的云 MySQL）为准
- 本地开发版仅用于离线调试，可随时停用
