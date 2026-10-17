#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "MP3 轉 MP4 網頁已啟動：http://localhost:$PORT"
echo "（關閉這個視窗就會停止）"
(sleep 1 && open "http://localhost:$PORT") &
python3 -m http.server $PORT
