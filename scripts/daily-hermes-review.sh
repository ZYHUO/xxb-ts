#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"
OPENCLAW_AGENT="${OPENCLAW_AGENT:-main}"
SESSION_KEY="${OPENCLAW_SESSION_KEY:-agent:main:telegram:direct:8744490096}"
CHANNEL_LABEL="${OPENCLAW_CHANNEL_LABEL:-telegram:8744490096}"
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"
NOW_LOCAL="$(TZ="$TZ_NAME" date '+%F %T %Z')"
TODAY_LOCAL="$(TZ="$TZ_NAME" date '+%F')"
YESTERDAY_LOCAL="$(TZ="$TZ_NAME" date -d 'yesterday' '+%F')"
LOG_DIR="${ROOT_DIR}/logs"
REPORT_PATH="${LOG_DIR}/hermes-daily-review-${TODAY_LOCAL}.md"
CRON_LOG_PATH="${LOG_DIR}/daily-hermes-cron.log"
OUT0_PATH="${LOG_DIR}/out-0.log"
ERROR0_PATH="${LOG_DIR}/error-0.log"

mkdir -p "$LOG_DIR"

if [[ -z "$OPENCLAW_BIN" || ! -x "$OPENCLAW_BIN" ]]; then
  echo "[$(date -Is)] openclaw binary not found" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  echo "[$(date -Is)] repo not found at $ROOT_DIR" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

append_section() {
  local title="$1"
  shift
  {
    echo
    echo "## ${title}"
    "$@"
  } >> "$REPORT_PATH"
}

{
  echo "# Hermes Daily Review - ${TODAY_LOCAL}"
  echo
  echo "- Generated: ${NOW_LOCAL}"
  echo "- Repo: ${ROOT_DIR}"
  echo "- Review window: ${YESTERDAY_LOCAL} 01:00 ${TZ_NAME} -> ${TODAY_LOCAL} 01:00 ${TZ_NAME}"
  echo
  echo "This report captures runtime signals, repository state, and Hermes review output for the last day."
} > "$REPORT_PATH"

append_section "Git Status" git -C "$ROOT_DIR" status --short
append_section "Recent Commits" git -C "$ROOT_DIR" log --oneline -n 8

if [[ -f "$OUT0_PATH" ]]; then
  append_section "Recent out-0.log (tail 200)" tail -n 200 "$OUT0_PATH"
fi

if [[ -f "$ERROR0_PATH" ]]; then
  append_section "Recent error-0.log (tail 120)" tail -n 120 "$ERROR0_PATH"
fi

PROMPT=$(cat <<EOF
Please review the project at ${ROOT_DIR} based on the current code and recent runtime evidence.

Context:
- Daily review time: ${NOW_LOCAL}
- Review window: ${YESTERDAY_LOCAL} 01:00 ${TZ_NAME} -> ${TODAY_LOCAL} 01:00 ${TZ_NAME}
- Focus on recent logs, likely user-visible issues, operational problems, code quality, and opportunities for optimization or new features.
- If there are safe, minimal fixes clearly warranted, you may make them. Otherwise provide a prioritized review and recommendations.
- Write your full answer directly in Markdown so it can be appended to the report file at ${REPORT_PATH}.

Required output structure:
## Hermes Review
- Findings ordered by severity/impact
- Suggested optimizations
- New feature ideas worth considering
- Fixes applied today (or say none)
- Validation performed
- Suggested next actions
EOF
)

{
  echo
  echo "## Hermes Invocation"
  echo '- Tool: openclaw sessions spawn/summarize via CLI prompt'
  echo '- Prompt sent:'
  echo '```text'
  echo "$PROMPT"
  echo '```'
} >> "$REPORT_PATH"

TMP_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "$TMP_OUTPUT"
}
trap cleanup EXIT

if ! "$OPENCLAW_BIN" --help >/dev/null 2>&1; then
  echo "[$(date -Is)] openclaw executable failed basic health check" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

python3 - <<'PY' "$OPENCLAW_BIN" "$OPENCLAW_AGENT" "$PROMPT" "$TMP_OUTPUT"
import subprocess
import sys
from pathlib import Path

openclaw_bin, agent, prompt, output_path = sys.argv[1:5]
result = subprocess.run(
    [openclaw_bin, 'agent', '--agent', agent, '--message', prompt, '--json'],
    capture_output=True,
    text=True,
    timeout=600,
)
combined = ''
if result.stderr:
    combined += result.stderr
if result.stdout:
    if combined and not combined.endswith('\n'):
        combined += '\n'
    combined += result.stdout
Path(output_path).write_text(combined, encoding='utf-8')
sys.exit(result.returncode)
PY

python3 - <<'PY' "$TMP_OUTPUT" "$REPORT_PATH"
import json
import sys
from pathlib import Path

out_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])
raw = out_path.read_text(encoding='utf-8', errors='replace')
review_text = None
json_obj = None

for idx, ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        json_obj = json.loads(raw[idx:])
        break
    except json.JSONDecodeError:
        continue

if isinstance(json_obj, dict):
    payloads = (((json_obj.get('result') or {}).get('payloads')) or [])
    texts = [p.get('text', '') for p in payloads if isinstance(p, dict) and p.get('text')]
    if texts:
        review_text = "\n\n".join(texts).strip()

with report_path.open('a', encoding='utf-8') as f:
    f.write("\n## OpenClaw Output\n")
    if review_text:
        f.write(review_text)
        f.write("\n")
    else:
        f.write("```text\n")
        f.write(raw)
        if not raw.endswith("\n"):
            f.write("\n")
        f.write("```\n")
PY

if [[ -n "$SESSION_KEY" ]]; then
  MESSAGE="每日 Hermes 审查已完成：\n${REPORT_PATH}\n请读取并把具体更改、建议和结论发给我。"
  "$OPENCLAW_BIN" send --session "$SESSION_KEY" --message "$MESSAGE" >/dev/null 2>&1 || true
fi

if [[ -n "$CHANNEL_LABEL" ]]; then
  echo "[$(date -Is)] report ready: ${REPORT_PATH}" >> "$CRON_LOG_PATH"
fi

echo "Daily Hermes review completed: ${REPORT_PATH}"
