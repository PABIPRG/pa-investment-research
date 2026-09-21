#!/bin/sh
# Run explicitly as administrator from a reviewed checkout; does not restart services.
set -eu
test "$(id -u)" -eq 0 || { echo 'Run as root.' >&2; exit 1; }
test "$#" -eq 0 || exit 64
test -x /usr/bin/python3
/usr/bin/python3 -I -c 'import sys; assert sys.version_info >= (3, 8), "Python 3.8+ required"'
command -v docker >/dev/null
command -v visudo >/dev/null
command -v curl >/dev/null
command -v du >/dev/null
tar --version | head -n 1 | grep 'GNU tar' >/dev/null
getent passwd pa-deployer >/dev/null
case " $(id -nG pa-deployer) " in
  *' docker '*|*' sudo '*|*' wheel '*) echo 'pa-deployer must not have general administrative groups.' >&2; exit 1 ;;
esac
docker compose version
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test -f /home/admin/pa-investment-deploy/compose.yaml
test -f /home/admin/pa-investment-deploy/.env
test -f /home/admin/pa-investment-deploy/web-admin-password.hash
test ! -e /var/lib/pa-investment-deploy/active.json
test ! -L /usr/local/libexec/pa-investment
test ! -L /usr/local/sbin/pa-investment-deploy
test ! -L /etc/sudoers.d/pa-investment-deploy
test ! -L /var/lib/pa-investment-deploy
test ! -L /etc/pa-investment-deploy
test ! -L /etc/pa-investment-deploy/docker
test ! -L /home/admin/pa-investment-backups/controlled-deployments
visudo -cf "$source_dir/pa-investment-deploy.sudoers"
install -d -o root -g root -m 0755 /usr/local/libexec/pa-investment
install -d -o root -g root -m 0700 /var/lib/pa-investment-deploy
install -d -o root -g root -m 0700 /etc/pa-investment-deploy/docker
install -d -o root -g root -m 0700 /home/admin/pa-investment-backups/controlled-deployments
install -o root -g root -m 0644 "$source_dir/deploy.py" /usr/local/libexec/pa-investment/deploy.py
install -o root -g root -m 0755 "$source_dir/pa-investment-deploy" /usr/local/sbin/pa-investment-deploy
install -o root -g root -m 0440 "$source_dir/pa-investment-deploy.sudoers" /etc/sudoers.d/pa-investment-deploy
visudo -c
echo 'Installed. No container was stopped or deployed. Verify permissions before enabling CI.'
