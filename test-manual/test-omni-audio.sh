#!/bin/bash
# 测试 omni_reference 模式音频支持
# 用法: TOKEN=your_token ./test-omni-audio.sh
# 或:   TOKEN=your_token BASE_URL=http://your-server:5100 ./test-omni-audio.sh

BASE_URL="${BASE_URL:-http://localhost:5100}"
TOKEN="${TOKEN:-your_session_token_here}"

echo "=== 测试1: 图片 + 音频混合（文件上传）==="
echo "注意：替换 /path/to/test.jpg 和 /path/to/test.mp3 为实际文件路径"
curl -s -X POST "${BASE_URL}/v1/videos/generations" \
  -H "Authorization: ${TOKEN}" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "prompt=使用@image_file_1图片，配合@audio_file_1音乐生成视频" \
  -F "functionMode=omni_reference" \
  -F "duration=5" \
  -F "ratio=16:9" \
  -F "image_file_1=@/path/to/test.jpg" \
  -F "audio_file_1=@/path/to/test.mp3" | jq .

echo ""
echo "=== 测试2: 图片URL + 音频URL ==="
curl -s -X POST "${BASE_URL}/v1/videos/generations" \
  -H "Authorization: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "配合音乐生成视频",
    "functionMode": "omni_reference",
    "duration": 5,
    "image_file_1": "https://example.com/test.jpg",
    "audio_file_1": "https://example.com/test.mp3"
  }' | jq .

echo ""
echo "=== 测试3: 验证错误处理（超出音频数量限制）==="
curl -s -X POST "${BASE_URL}/v1/videos/generations" \
  -H "Authorization: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "测试",
    "functionMode": "omni_reference",
    "image_file_1": "https://example.com/test.jpg",
    "audio_file_1": "https://example.com/1.mp3",
    "audio_file_2": "https://example.com/2.mp3",
    "audio_file_3": "https://example.com/3.mp3"
  }' | jq .
