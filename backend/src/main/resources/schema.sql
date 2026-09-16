-- TimeMark 表结构（§4 数据模型 + §5 变更流）—— 全部幂等，可重复执行
-- 用户须先执行：CREATE DATABASE timemark DEFAULT CHARSET utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(64) PRIMARY KEY,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(128) NOT NULL,
  created_at    BIGINT
);

CREATE TABLE IF NOT EXISTS timer_item (
  id               VARCHAR(64) PRIMARY KEY,
  user_id          VARCHAR(64),
  name             VARCHAR(128),
  type             VARCHAR(32),
  color            VARCHAR(16),
  starred          TINYINT DEFAULT 0,
  pinned           TINYINT DEFAULT 0,
  remark           VARCHAR(512) DEFAULT '',
  config_json      TEXT,
  run_state        VARCHAR(16) DEFAULT 'idle',
  session_id       VARCHAR(64),
  run_json         TEXT,
  version          INT DEFAULT 1,
  updated_at       BIGINT,
  deleted          TINYINT DEFAULT 0,
  origin_device_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS tag (
  id               VARCHAR(64) PRIMARY KEY,
  user_id          VARCHAR(64),
  name             VARCHAR(64),
  color            VARCHAR(16),
  version          INT DEFAULT 1,
  updated_at       BIGINT,
  deleted          TINYINT DEFAULT 0,
  origin_device_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS timer_tag (
  id               VARCHAR(64) PRIMARY KEY,
  user_id          VARCHAR(64),
  timer_id         VARCHAR(64),
  tag_id           VARCHAR(64),
  version          INT DEFAULT 1,
  updated_at       BIGINT,
  deleted          TINYINT DEFAULT 0,
  origin_device_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS milestone (
  id               VARCHAR(64) PRIMARY KEY,
  user_id          VARCHAR(64),
  timer_id         VARCHAR(64),
  note             VARCHAR(512),
  marked_at        BIGINT,
  version          INT DEFAULT 1,
  updated_at       BIGINT,
  deleted          TINYINT DEFAULT 0,
  origin_device_id VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS timer_record (
  id               VARCHAR(64) PRIMARY KEY,
  user_id          VARCHAR(64),
  timer_id         VARCHAR(64),
  session_id       VARCHAR(64),
  started_at       BIGINT,
  ended_at         BIGINT,
  duration_sec     INT,
  record_type      VARCHAR(32),
  version          INT DEFAULT 1,
  updated_at       BIGINT,
  deleted          TINYINT DEFAULT 0,
  origin_device_id VARCHAR(64),
  INDEX idx_record_timer (timer_id)
);

-- §5.2 变更日志：change_seq 单调递增，pull 按它分页
CREATE TABLE IF NOT EXISTS change_log (
  change_seq       BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id          VARCHAR(64),
  table_name       VARCHAR(32),
  row_id           VARCHAR(64),
  op_type          VARCHAR(16),
  payload          TEXT,
  origin_device_id VARCHAR(64),
  committed_at     BIGINT
);

-- §5.4 push 幂等表：已见过的 operation_id 直接返回原结果
CREATE TABLE IF NOT EXISTS ops (
  operation_id VARCHAR(64) PRIMARY KEY,
  user_id      VARCHAR(64),
  response     VARCHAR(255),
  created_at   BIGINT
);

CREATE TABLE IF NOT EXISTS meta (
  meta_key VARCHAR(64) PRIMARY KEY,
  val      VARCHAR(255)
);
