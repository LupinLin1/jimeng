#!/bin/bash

# 测试 seedance 2.0 omni_reference 模式
# 必须提供参考视频 URL

API_BASE="http://localhost:5100"

echo "=== Seedance 2.0 Omni Reference 模式测试 ==="
echo ""

# 使用公共图片 URL 作为参考（更稳定）
IMAGE_URL="https://images.unsplash.com/photo-1574158622682-e40e69881006?w=800"

echo "📝 发送 omni_reference 模式请求（使用图片参考）..."
echo "参考图片: $IMAGE_URL"
echo ""

curl -s -X POST "$API_BASE/v1/videos/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer cff8c2ee2af8fe709655b1417aac33ab" \
  -d "{
    \"model\": \"jimeng-video-seedance-2.0\",
    \"prompt\": \"@image1 一只可爱的猫咪在草地上玩耍\",
    \"functionMode\": \"omni_reference\",
    \"image_file_1\": \"$IMAGE_URL\",
    \"ratio\": \"16:9\",
    \"duration\": 4
  }" | jq .

echo ""
echo "=== 测试完成 ==="
