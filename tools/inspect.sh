echo '=== OS ==='
cat /etc/os-release | head -2
uname -r
uptime
echo '=== MEM ==='
free -h
echo '=== DISK ==='
df -h / 2>/dev/null
echo '=== TOP PROC (mem) ==='
ps aux --sort=-%mem | head -12
echo '=== RUNNING SERVICES ==='
systemctl list-units --type=service --state=running --no-pager --no-legend | head -40
echo '=== LISTEN PORTS ==='
sudo -n ss -tlnp 2>/dev/null || ss -tln | head -25
echo '=== DOCKER ==='
sudo -n docker ps -a 2>/dev/null || docker ps -a 2>/dev/null || echo 'no-docker'
echo '=== ENABLED SERVICES ==='
systemctl list-unit-files --type=service --state=enabled --no-pager --no-legend | head -30
echo '=== CPU COUNT ==='
nproc
echo '=== DONE ==='
