#!/bin/bash
# Give the independently running completion preview trusted public TLS.
# Changes only its HTTPS gateway; never restarts a Hub, Computer or CLI.
set -euo pipefail
if [[ $(id -u) != 0 ]]; then
  echo 'Run this command in a root shell; the existing certificate/DNS credential is root-owned.' >&2
  exit 1
fi
preview_dir=${1:-/tmp/codoxear-v2-completion-preview}
[[ "$preview_dir" == /tmp/codoxear-v2-completion-preview ]] || { echo 'This installer is restricted to the completion preview.' >&2; exit 1; }
service_name=codoxear-v2-completion-https
service_config=/etc/codoxear-v2-completion-https/Caddyfile
service_state=/var/lib/codoxear-v2-completion-https
node_bin=/opt/codoxear-tools/node/bin/node
[[ -x /usr/local/bin/caddy && -x "$node_bin" && -r /etc/codoxear-https/cloudflare.env ]]
for port in 19500 19520 19530 19531; do [[ -S "$preview_dir/bridge/$port.sock" ]]; done
[[ -r "$preview_dir/processes.json" ]]
install -d -m 0700 /etc/codoxear-v2-completion-https "$service_state/data/caddy/certificates"
# Bootstrap from a currently trusted root-managed certificate, when available.
# Private key material remains in root-owned storage and is never printed.
cache_seeded=false
for cache in /var/lib/codoxear-v2-demo-https/data/caddy/certificates /var/lib/codoxear-https/data/caddy/certificates; do
  [[ -d "$cache" ]] || continue
  while IFS= read -r -d '' cert; do
    [[ -f "${cert%.crt}.key" && -f "${cert%.crt}.json" ]] || continue
    openssl x509 -in "$cert" -noout -checkhost codoxear.gzeek.com >/dev/null 2>&1 || continue
    openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null 2>&1 || continue
    openssl verify -CApath /etc/ssl/certs -untrusted "$cert" "$cert" >/dev/null 2>&1 || continue
    relative=${cert#"$cache/"}
    destination="$service_state/data/caddy/certificates/$(dirname "$relative")"
    install -d -m 0700 "$destination"
    cp -a "$(dirname "$cert")/." "$destination/"
    chown -R root:root "$destination"
    chmod 0700 "$destination"
    chmod 0600 "$destination"/*
    cache_seeded=true
    break
  done < <(find "$cache" -type f -name codoxear.gzeek.com.crt -print0)
  [[ "$cache_seeded" == true ]] && break
done
cat > "$service_config" <<CONFIG
{
  admin off
  auto_https disable_redirects
}
(preview_tls) {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
    resolvers 1.1.1.1 8.8.8.8
  }
}
https://codoxear.gzeek.com:8470 {
  import preview_tls
  reverse_proxy unix/$preview_dir/bridge/19500.sock
}
https://codoxear.gzeek.com:8471 {
  import preview_tls
  reverse_proxy unix/$preview_dir/bridge/19520.sock {
    flush_interval -1
  }
}
https://codoxear.gzeek.com:8472 {
  import preview_tls
  reverse_proxy unix/$preview_dir/bridge/19530.sock {
    flush_interval -1
  }
}
https://codoxear.gzeek.com:8473 {
  import preview_tls
  reverse_proxy unix/$preview_dir/bridge/19531.sock {
    flush_interval -1
  }
}
CONFIG
/usr/local/bin/caddy adapt --config "$service_config" --adapter caddyfile >/dev/null
cat > /etc/systemd/system/$service_name.service <<UNIT
[Unit]
Description=Codoxear v2 completion preview with trusted public HTTPS
Wants=network-online.target
After=network-online.target
[Service]
Type=notify
StateDirectory=$service_name
StateDirectoryMode=0700
Environment=XDG_DATA_HOME=$service_state/data
Environment=XDG_CONFIG_HOME=$service_state/config
EnvironmentFile=/etc/codoxear-https/cloudflare.env
ExecStart=/usr/local/bin/caddy run --config $service_config --adapter caddyfile
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=false
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
if ! systemctl is-active --quiet "$service_name.service"; then
  # Verify the exact recorded process before stopping this one preview gateway.
  "$node_bin" --input-type=module - "$preview_dir" <<'NODE'
import fs from 'node:fs';
const directory=process.argv[2];
const pid=JSON.parse(fs.readFileSync(directory+'/processes.json')).gatewayPid;
if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid recorded preview gateway PID');
try {
  const command=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
  const executable=fs.readlinkSync('/proc/'+pid+'/exe');
  if(executable!=='/usr/local/bin/caddy'||!command.includes(directory+'/Caddyfile'))throw Error('Recorded PID is not this preview gateway');
  process.kill(pid,'SIGTERM');
  for(let n=0;n<100;n++){
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
} catch(e) {if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}
NODE
fi
systemctl enable "$service_name.service"
systemctl restart "$service_name.service"
systemctl is-active --quiet "$service_name.service"
printf 'Trusted HTTPS gateway started for https://codoxear.gzeek.com:8471/\n'
printf 'Existing gateways, Hubs, Computers and CLI sessions were not restarted.\n'
