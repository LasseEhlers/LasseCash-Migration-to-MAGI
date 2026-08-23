#!/usr/bin/env bash
# Resume the Hive gift run. Safe to call any number of times.
#
# The sender stops on its own when @lassecashmagi runs out of RC, records every
# confirmed recipient in hive_gift_sent.json, and skips them on the next run.
# So this is simply "try to make progress", and it is a no-op once finished.
#
# Installed as a cron job so the run survives reboots and does not depend on
# anyone remembering it. Remove the crontab line when the log says 4,443.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG="tools/snapshot/data/hive_gift_cron.log"
SENT=$(python3 -c "import json;print(len(json.load(open('tools/snapshot/data/hive_gift_sent.json'))))" 2>/dev/null || echo 0)
if [ "$SENT" -ge 4443 ]; then
  echo "$(date -Is)  complete ($SENT/4443) — nothing to do" >> "$LOG"
  exit 0
fi
echo "$(date -Is)  resuming at $SENT/4443" >> "$LOG"
timeout 3000 node tools/donate-hive-actives.js >> "$LOG" 2>&1
AFTER=$(python3 -c "import json;print(len(json.load(open('tools/snapshot/data/hive_gift_sent.json'))))" 2>/dev/null || echo "$SENT")
echo "$(date -Is)  stopped at $AFTER/4443 (+$((AFTER-SENT)))" >> "$LOG"
