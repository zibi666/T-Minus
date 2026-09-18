#!/usr/bin/env bash
# 仓库历史瘦身：把已退出跟踪的 SDK / 构建产物 / 本机临时文件从**全部历史**里抹掉。
#
# 为什么需要：.git 目前约 1.2 GB，绝大多数是 tools/android（Android SDK + JDK + Gradle 发行版）。
# .gitignore 只能阻止后续提交，历史里的 blob 仍会随每次 clone 传输。
#
# 这个脚本是不可逆的（会重写所有 commit hash），所以：
#   1) 先做完整 bundle 备份，重写失败可以从备份恢复；
#   2) 不自动 push —— 最后一步打印出来由你核对后手工执行。
#
# 用法：bash tools/repo-slim.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
BACKUP="../timemark-history-backup.bundle"

echo "== 0. 前置检查 =="
if [ -n "$(git status --porcelain)" ]; then
  echo "工作树不干净，先提交或 stash 后再跑"; git status --short | head; exit 1
fi
git fetch origin
LOCAL_ONLY=$(git rev-list --count origin/main..HEAD)
REMOTE_ONLY=$(git rev-list --count HEAD..origin/main)
echo "本地领先 $LOCAL_ONLY 个提交，远端领先 $REMOTE_ONLY 个提交"
if [ "$REMOTE_ONLY" != "0" ]; then
  echo "远端有本地没有的提交（可能是另一台机器或另一个会话推的）。先 rebase/merge 再回来。"; exit 1
fi
if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "缺 git-filter-repo。装一个： pipx install git-filter-repo  （或 pip install --user git-filter-repo）"
  exit 1
fi

echo "== 1. 备份全量历史到 $BACKUP =="
if [ -f "$BACKUP" ]; then echo "$BACKUP 已存在，覆盖前先确认它是不是你要的备份"; exit 1; fi
git bundle create "$BACKUP" --all
echo "备份 $(du -h "$BACKUP" | cut -f1)，恢复方式：git clone '$BACKUP' restored"

echo "== 2. 从历史中剔除这些路径 =="
# 只删产物与本机数据；源码、docs、shared 契约、release 说明一律保留
git filter-repo --force --invert-paths \
  --path tools/android \
  --path tools/android-dl \
  --path apps/android/.gradle \
  --path apps/android/local.properties \
  --path apps/windows/dist \
  --path .workbuddy \
  --path server \
  --path-rex '^apps/windows/release[^/]*/.*' \
  --path-rex '^apps/windows/[^/]*\.(txt|log|done)$' \
  --path-rex '^tools/[^/]*\.(txt|log|done)$' \
  --path-rex '(^|/)[^/]*\.log$' \
  --path-rex '.*\.apk$' \
  --path-rex '.*\.exe$' \
  --path-rex '.*\.jar$'

echo "== 3. 收紧对象库 =="
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo "== 4. 结果自检 =="
echo ".git 体积：$(du -sh .git | cut -f1)"
echo "跟踪文件数：$(git ls-files | wc -l | tr -d ' ')（重写前约 12,629，工作区已降到 139）"
echo "提交数：$(git rev-list --count HEAD)"
git ls-files | grep -E "^tools/android|^apps/android/\.gradle|^apps/windows/(dist|release)|\.log$" \
  && { echo "仍有产物路径被跟踪，请检查上面的 --path 列表"; exit 1; } || echo "产物路径已彻底不在跟踪列表"

echo
echo "== 5. 最后一步（确认后手工执行）=="
echo "filter-repo 已移除 origin，先加回来："
echo "  git remote add origin $(git config --get remote.origin.url 2>/dev/null || echo 'git@github.com:zibi666/T-Minus.git')"
echo "核对无误后强推 main（会覆盖远端历史，其他克隆必须重新 clone）："
echo "  git push --force origin main"
echo
echo "GitHub 服务端仍会暂时保留旧 pack（可达性缓存），彻底回收需要提工单或用一次空的 force-push 触发 GC。"
echo "出问题就回滚：git clone '$BACKUP' restored && cp -r restored/.git ."
