#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  echo 'Run this installer as root: it adds a separate demo gateway using the existing protected DNS credential.' >&2
  exit 1
fi
demo_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test -r /etc/codoxear-https/cloudflare.env
test -x /usr/local/bin/caddy
/usr/local/bin/caddy adapt --config "$demo_source/demo.Caddyfile" --adapter caddyfile >/dev/null
install -d -m 0755 /etc/codoxear-v2-demo
if [ -f /etc/codoxear-v2-demo/Caddyfile ]; then
  cp -p /etc/codoxear-v2-demo/Caddyfile /etc/codoxear-v2-demo/Caddyfile.previous
fi
install -m 0644 "$demo_source/demo.Caddyfile" /etc/codoxear-v2-demo/Caddyfile
install -m 0644 "$demo_source/demo-https.service" /etc/systemd/system/codoxear-v2-demo-https.service
systemctl daemon-reload
systemctl enable codoxear-v2-demo-https.service
systemctl restart codoxear-v2-demo-https.service
echo 'Demo gateway started. Its certificate is obtained through the existing DNS credential.'
echo 'Demo URL: https://codoxear.gzeek.com:8444/'
echo 'The existing codoxear-https.service and backend were not restarted.'
