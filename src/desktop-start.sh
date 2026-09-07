#!/usr/bin/env bash
"$HOME/.local/bin/chatgpt-pro-start"
result=$?
printf '\n启动检查结束（状态码 %s）。可以关闭这个终端，保留 Edge 运行即可。\n' "$result"
read -r -p '按回车关闭此终端……' _ || true
exit "$result"
