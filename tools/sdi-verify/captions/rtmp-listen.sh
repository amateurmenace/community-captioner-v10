#!/bin/bash
# Accept Web Presenter RTMP connections one after another; each becomes capN.ts
cd "$(dirname "$0")"
for i in $(seq 1 30); do
  echo "$(date +%T) waiting for connection #$i" >> listen.log
  ffmpeg -nostdin -v warning -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy -f mpegts "cap$i.ts" >> listen.log 2>&1
  echo "$(date +%T) connection #$i ended (exit $?)" >> listen.log
done
