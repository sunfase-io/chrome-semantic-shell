#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/index.js"
NODE_EXEC="${CHROME_SHELL_NODE_PATH:-}"

if [ -n "${NODE_EXEC}" ] && [ -d "${NODE_EXEC}" ]; then
  NODE_EXEC="${NODE_EXEC%/}/node"
fi
if [ -n "${NODE_EXEC}" ] && [ ! -x "${NODE_EXEC}" ]; then
  NODE_EXEC=""
fi

if [ -z "${NODE_EXEC}" ] && [ -f "${SCRIPT_DIR}/node_path.txt" ]; then
  NODE_EXEC="$(tr -d '\r\n' < "${SCRIPT_DIR}/node_path.txt")"
  if [ ! -x "${NODE_EXEC}" ]; then
    NODE_EXEC=""
  fi
fi

if [ -z "${NODE_EXEC}" ]; then
  NODE_EXEC="$(command -v node 2>/dev/null || true)"
fi

[ -n "${NODE_EXEC}" ] && [ -x "${NODE_EXEC}" ] || exit 1
[ -f "${NODE_SCRIPT}" ] || exit 1

if [ "$(uname)" = "Darwin" ]; then
  LOG_DIR="${HOME}/Library/Logs/chrome-semantic-shell"
else
  LOG_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/chrome-semantic-shell/logs"
fi

if mkdir -p "${LOG_DIR}" 2>/dev/null; then
  exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native-host.log"
fi
exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>/dev/null
