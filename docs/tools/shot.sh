#!/bin/bash
# 无头截图：./tools/shot.sh <url> <输出.png> [等待ms] [宽] [高]
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="${1:?usage: shot.sh <url> <out.png> [wait-ms] [w] [h]}"
OUT="${2:-screenshot.png}"
WAIT="${3:-6000}"
W="${4:-1600}"
H="${5:-900}"
"$CHROME" --headless=new --hide-scrollbars \
  --screenshot="$OUT" --window-size=$W,$H \
  --virtual-time-budget=$WAIT "$URL" 2>/dev/null
echo "saved: $OUT"
