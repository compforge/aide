#!/usr/bin/env bash
set -euo pipefail

# Install from the checkout to run. Credentials and state stay in the user's home.
aide_repo=$(cd "$(dirname "$0")/.." && pwd)
aide_node=$(command -v node)
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Aide requires Node.js 22+")'
command -v codex >/dev/null
test -d "$aide_repo/node_modules/tsx" || { echo 'Run npm ci before installing the service.' >&2; exit 1; }
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/aide"
if ! test -f "$HOME/.config/aide/env"; then
  (umask 077; printf '# AIDE_CWD=/path/to/work\n# AIDE_TIMEZONE=Asia/Shanghai\n' > "$HOME/.config/aide/env")
fi
aide_revision=${AIDE_REVISION:-$(git -C "$aide_repo" rev-parse --short HEAD 2>/dev/null || echo development)}
cat > "$HOME/.config/systemd/user/aide.service" <<EOF
[Unit]
Description=Aide personal agent
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory="$aide_repo"
ExecStart="$aide_node" --import tsx "$aide_repo/src/main.ts"
Environment="PATH=$PATH"
Environment="AIDE_REVISION=$aide_revision"
EnvironmentFile=-%h/.config/aide/env
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable aide.service
systemctl --user restart aide.service
echo 'Installed aide.service. Logs: journalctl --user -u aide -f'
if [ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]; then
  echo 'To keep Aide running after logout: loginctl enable-linger '"$(id -un)"
fi
