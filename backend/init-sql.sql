-- 部署前在腾讯云 TDSQL-C MySQL 上执行一次（用 DMC / 命令行均可）
-- 数据库名与 TIMEMARK_DB_URL 中的库名保持一致（默认 timemark）
CREATE DATABASE IF NOT EXISTS timemark DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
USE timemark;

-- 表结构无需手动建：后端首次启动会自动执行 schema.sql（全部 CREATE TABLE IF NOT EXISTS，幂等）
-- 以下索引建议手动建一次（量级小，不建也不影响正确性）：
CREATE INDEX idx_timer_user ON timemark.timer_item (user_id, deleted);
CREATE INDEX idx_record_timer ON timemark.timer_record (timer_id);
CREATE INDEX idx_change_user ON timemark.change_log (user_id, change_seq);
