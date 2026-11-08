#!/bin/bash
# 启动本地服务器：./start.sh [端口]
cd "$(dirname "$0")"
PORT="${1:-8173}"
echo "飞行模拟器运行在 http://localhost:$PORT"
python3 -m http.server "$PORT" --directory .
