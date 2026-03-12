# Seedance 音频参考支持实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 seedance 模型的 `omni_reference` 模式新增音频文件（`audio_file_*`）支持，用户可同时提供图片/视频作为视觉素材和音频作为声音参考。

**Architecture:** 音频与视频走相同的 ByteDance VOD 上传流程（ApplyUploadInner → Upload → CommitUploadInner），在 `material_list` 中使用 `audio_info` 条目。同时修复 `omni_reference` 模式中 `benefit_type` 未动态追加 `_with_video` 的 bug。

**Tech Stack:** TypeScript, Koa, Axios, ByteDance VOD API (`vod.bytedanceapi.com`)

---

### Task 1: 新增 AudioUploadResult 接口和 uploadAudioBuffer 函数

**Files:**
- Modify: `src/lib/video-uploader.ts`（在文件末尾追加）

**Step 1: 在 video-uploader.ts 末尾追加 AudioUploadResult 接口和 uploadAudioBuffer 函数**

在文件末尾（第 327 行之后）追加：

```typescript
export interface AudioUploadResult {
  vid: string;
  duration: number;  // 毫秒
  name: string;
}

/**
 * 上传音频 Buffer 到 VOD
 * 与视频上传流程相同，但不校验时长上限
 */
export async function uploadAudioBuffer(
  audioBuffer: ArrayBuffer | Buffer,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<AudioUploadResult> {
  try {
    const fileSize = (audioBuffer as Buffer).byteLength ?? (audioBuffer as ArrayBuffer).byteLength;
    logger.info(`开始上传音频Buffer... (size=${fileSize})`);

    const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {
      data: { scene: 1 },
    });

    const { access_key_id, secret_access_key, session_token, space_name } = tokenResult;
    if (!access_key_id || !secret_access_key || !session_token) {
      throw new Error("获取音频上传令牌失败");
    }

    const spaceName = space_name || "dreamina";
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const randomStr = Math.random().toString(36).substring(2, 12);

    const vodHost = "https://vod.bytedanceapi.com";
    const applyUrl = `${vodHost}/?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=${spaceName}&FileType=video&IsInner=1&FileSize=${fileSize}&s=${randomStr}`;

    const awsRegion = RegionUtils.getAWSRegion(regionInfo);
    const origin = RegionUtils.getOrigin(regionInfo);

    const requestHeaders = {
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token,
    };

    const authorization = createSignature(
      'GET', applyUrl, requestHeaders,
      access_key_id, secret_access_key, session_token,
      '', awsRegion, 'vod'
    );

    let applyResponse;
    try {
      applyResponse = await axios({
        method: 'GET',
        url: applyUrl,
        headers: {
          'accept': '*/*',
          'authorization': authorization,
          'origin': origin,
          'referer': RegionUtils.getRefererPath(regionInfo),
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
          'x-amz-date': timestamp,
          'x-amz-security-token': session_token,
        },
        validateStatus: () => true,
      });
    } catch (fetchError: any) {
      throw new Error(`音频上传申请网络请求失败: ${fetchError.message}`);
    }

    if (applyResponse.status < 200 || applyResponse.status >= 300) {
      throw new Error(`申请音频上传权限失败: ${applyResponse.status}`);
    }

    const applyResult = applyResponse.data;
    if (applyResult?.ResponseMetadata?.Error) {
      throw new Error(`申请音频上传权限失败: ${JSON.stringify(applyResult.ResponseMetadata.Error)}`);
    }

    const uploadNodes = applyResult?.Result?.InnerUploadAddress?.UploadNodes;
    if (!uploadNodes || uploadNodes.length === 0) {
      throw new Error(`获取音频上传节点失败: ${JSON.stringify(applyResult)}`);
    }

    const uploadNode = uploadNodes[0];
    const storeInfo = uploadNode.StoreInfos?.[0];
    if (!storeInfo) throw new Error(`获取音频上传存储信息失败`);

    const uploadHost = uploadNode.UploadHost;
    const storeUri = storeInfo.StoreUri;
    const auth = storeInfo.Auth;
    const sessionKey = uploadNode.SessionKey;
    const vid = uploadNode.Vid;

    logger.info(`获取音频上传节点成功: host=${uploadHost}, vid=${vid}`);

    const uploadUrl = `https://${uploadHost}/upload/v1/${storeUri}`;
    const crc32 = util.calculateCRC32(audioBuffer);

    let uploadResponse;
    try {
      uploadResponse = await axios({
        method: 'POST',
        url: uploadUrl,
        headers: {
          'Accept': '*/*',
          'Authorization': auth,
          'Content-CRC32': crc32,
          'Content-Type': 'application/octet-stream',
          'Origin': origin,
          'Referer': RegionUtils.getRefererPath(regionInfo),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        },
        data: audioBuffer,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
    } catch (fetchError: any) {
      throw new Error(`音频文件上传网络请求失败: ${fetchError.message}`);
    }

    if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
      throw new Error(`音频文件上传失败: ${uploadResponse.status}`);
    }

    const uploadData = uploadResponse.data;
    if (uploadData?.code !== 2000) {
      throw new Error(`音频文件上传失败: code=${uploadData?.code}, message=${uploadData?.message}`);
    }

    logger.info(`音频文件上传成功: crc32=${uploadData.data?.crc32}`);

    const commitUrl = `${vodHost}/?Action=CommitUploadInner&Version=2020-11-19&SpaceName=${spaceName}`;
    const commitTimestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const commitPayload = JSON.stringify({ SessionKey: sessionKey, Functions: [] });
    const payloadHash = crypto.createHash('sha256').update(commitPayload, 'utf8').digest('hex');

    const commitRequestHeaders = {
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash,
    };

    const commitAuthorization = createSignature(
      'POST', commitUrl, commitRequestHeaders,
      access_key_id, secret_access_key, session_token,
      commitPayload, awsRegion, 'vod'
    );

    let commitResponse;
    try {
      commitResponse = await axios({
        method: 'POST',
        url: commitUrl,
        headers: {
          'accept': '*/*',
          'authorization': commitAuthorization,
          'content-type': 'application/json',
          'origin': origin,
          'referer': RegionUtils.getRefererPath(regionInfo),
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
          'x-amz-date': commitTimestamp,
          'x-amz-security-token': session_token,
          'x-amz-content-sha256': payloadHash,
        },
        data: commitPayload,
        validateStatus: () => true,
      });
    } catch (fetchError: any) {
      throw new Error(`提交音频上传网络请求失败: ${fetchError.message}`);
    }

    if (commitResponse.status < 200 || commitResponse.status >= 300) {
      throw new Error(`提交音频上传失败: ${commitResponse.status}`);
    }

    const commitResult = commitResponse.data;
    if (commitResult?.ResponseMetadata?.Error) {
      throw new Error(`提交音频上传失败: ${JSON.stringify(commitResult.ResponseMetadata.Error)}`);
    }

    if (!commitResult?.Result?.Results || commitResult.Result.Results.length === 0) {
      throw new Error(`提交音频上传响应缺少结果`);
    }

    const result = commitResult.Result.Results[0];
    if (!result.Vid) throw new Error(`提交音频上传响应缺少 Vid`);

    const videoMeta = result.VideoMeta || {};
    const durationMs = videoMeta.Duration ? Math.round(videoMeta.Duration * 1000) : 0;

    logger.info(`音频上传完成: vid=${result.Vid}, duration=${durationMs}ms`);

    return {
      vid: result.Vid,
      duration: durationMs,
      name: '',
    };
  } catch (error: any) {
    logger.error(`音频Buffer上传失败: ${error.message}`);
    throw error;
  }
}

/**
 * 从 URL 下载并上传音频
 */
export async function uploadAudioFromUrl(
  audioUrl: string,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<AudioUploadResult> {
  try {
    logger.info(`开始从URL下载并上传音频: ${audioUrl}`);
    const audioResponse = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (audioResponse.status < 200 || audioResponse.status >= 300) {
      throw new Error(`下载音频失败: ${audioResponse.status}`);
    }
    const audioBuffer = audioResponse.data;
    logger.info(`音频下载完成: ${audioBuffer.byteLength} 字节`);
    return await uploadAudioBuffer(audioBuffer, refreshToken, regionInfo);
  } catch (error: any) {
    logger.error(`从URL上传音频失败: ${error.message}`);
    throw error;
  }
}
```

**Step 2: 运行类型检查**

```bash
cd /Users/lupin/Dev/jimeng-api && npm run type-check
```

期望输出：无类型错误

**Step 3: 提交**

```bash
git add src/lib/video-uploader.ts
git commit -m "feat: add audio upload functions to video-uploader"
```

---

### Task 2: 更新 videos.ts 的导入语句

**Files:**
- Modify: `src/api/controllers/videos.ts`（第 15 行）

**Step 1: 在 videos.ts 中找到当前导入**

当前第 15-16 行：
```typescript
import { uploadVideoBuffer, VideoUploadResult } from "@/lib/video-uploader.ts";
import { extractVideoUrl, fetchHighQualityVideoUrl } from "@/lib/image-utils.ts";
import { uploadVideoFromUrl } from "@/lib/video-uploader.ts";
```

**Step 2: 将两行 video-uploader 导入合并，并加入音频相关导出**

将第 15 行和第 17 行合并为一行：
```typescript
import { uploadVideoBuffer, VideoUploadResult, uploadVideoFromUrl, uploadAudioBuffer, uploadAudioFromUrl, AudioUploadResult } from "@/lib/video-uploader.ts";
```

并删除第 17 行（原有的第二个 video-uploader 导入）。

**Step 3: 运行类型检查**

```bash
npm run type-check
```

期望：无错误

**Step 4: 提交**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: import audio upload functions in videos controller"
```

---

### Task 3: 扩展 MaterialEntry 接口并增加 audio 字段检测

**Files:**
- Modify: `src/api/controllers/videos.ts`（omni_reference 分支，约第 277-330 行）

**Step 1: 修改 MaterialEntry 接口（第 277-284 行）**

将：
```typescript
interface MaterialEntry {
  idx: number;
  type: "image" | "video";
  fieldName: string;
  originalFilename: string;
  imageUri?: string;
  videoResult?: VideoUploadResult;
}
```

改为：
```typescript
interface MaterialEntry {
  idx: number;
  type: "image" | "video" | "audio";
  fieldName: string;
  originalFilename: string;
  imageUri?: string;
  videoResult?: VideoUploadResult;
  audioResult?: AudioUploadResult;
}
```

**Step 2: 扩展 canonicalKeys 集合（第 289-291 行）**

在两行 `for` 循环之后追加第三行：
```typescript
for (let i = 1; i <= 9; i++) canonicalKeys.add(`image_file_${i}`);
for (let i = 1; i <= 3; i++) canonicalKeys.add(`video_file_${i}`);
for (let i = 1; i <= 2; i++) canonicalKeys.add(`audio_file_${i}`);  // 新增
```

**Step 3: 在 imageFields/videoFields 声明后新增 audioFields（第 300-302 行）**

将：
```typescript
const imageFields: string[] = [];
const videoFields: string[] = [];
```

改为：
```typescript
const imageFields: string[] = [];
const videoFields: string[] = [];
const audioFields: string[] = [];
```

**Step 4: 在 files 检测循环中加入 audio 检测（第 306-309 行）**

将：
```typescript
for (const fieldName of Object.keys(files)) {
  if (fieldName.startsWith('image_file_')) imageFields.push(fieldName);
  else if (fieldName.startsWith('video_file_')) videoFields.push(fieldName);
}
```

改为：
```typescript
for (const fieldName of Object.keys(files)) {
  if (fieldName.startsWith('image_file_')) imageFields.push(fieldName);
  else if (fieldName.startsWith('video_file_')) videoFields.push(fieldName);
  else if (fieldName.startsWith('audio_file_')) audioFields.push(fieldName);
}
```

**Step 5: 在 URL 检测循环后新增音频 URL 检测（第 324 行之后）**

在检测 video URL 的循环之后追加：
```typescript
for (let i = 1; i <= 2; i++) {
  const fieldName = `audio_file_${i}`;
  if (typeof httpRequest?.body?.[fieldName] === 'string' && httpRequest.body[fieldName].startsWith('http')) {
    if (!audioFields.includes(fieldName)) audioFields.push(fieldName);
  }
}
```

**Step 6: 更新"检查是否有素材"的条件（第 328-331 行）**

将：
```typescript
if (imageFields.length === 0 && videoFields.length === 0 && !hasFilePaths) {
  throw new APIException(EX.API_REQUEST_FAILED,
    `omni_reference 模式需要至少上传一个素材文件 (image_file_*, video_file_*) 或提供素材URL`);
}
```

改为：
```typescript
if (imageFields.length === 0 && videoFields.length === 0 && audioFields.length === 0 && !hasFilePaths) {
  throw new APIException(EX.API_REQUEST_FAILED,
    `omni_reference 模式需要至少上传一个素材文件 (image_file_*, video_file_*, audio_file_*) 或提供素材URL`);
}
```

**Step 7: 运行类型检查**

```bash
npm run type-check
```

期望：无错误

**Step 8: 提交**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: add audio field detection to omni_reference mode"
```

---

### Task 4: 实现音频上传循环

**Files:**
- Modify: `src/api/controllers/videos.ts`（在视频上传循环结束之后，约第 461 行之后）

**Step 1: 在视频时长校验日志之后插入音频上传循环**

在第 463 行（`logger.info('[omni] 视频总时长...')`）之后，第 465 行（构建 material_list）之前插入：

```typescript
    // 串行上传音频素材
    for (const fieldName of audioFields) {
      const audioFile = files?.[fieldName];
      const audioUrlField = httpRequest?.body?.[fieldName];

      try {
        logger.info(`[omni] 上传 ${fieldName}`);
        let aResult: AudioUploadResult;

        if (audioFile) {
          const buf = await fs.readFile(audioFile.filepath);
          aResult = await uploadAudioBuffer(buf, refreshToken, regionInfo);
          aResult = { ...aResult, name: audioFile.originalFilename || "" };
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "audio",
            fieldName,
            originalFilename: audioFile.originalFilename,
            audioResult: aResult,
          };
          materialRegistry.set(fieldName, entry);
          registerAlias(audioFile.originalFilename, entry);
          logger.info(`[omni] ${fieldName} 上传成功: vid=${aResult.vid}, duration=${aResult.duration}ms`);
        } else if (audioUrlField && typeof audioUrlField === 'string' && audioUrlField.startsWith('http')) {
          aResult = await uploadAudioFromUrl(audioUrlField, refreshToken, regionInfo);
          const entry: MaterialEntry = {
            idx: materialIdx++,
            type: "audio",
            fieldName,
            originalFilename: audioUrlField,
            audioResult: aResult,
          };
          materialRegistry.set(fieldName, entry);
          logger.info(`[omni] ${fieldName} URL上传成功: vid=${aResult.vid}, duration=${aResult.duration}ms`);
        }
      } catch (error: any) {
        throw new APIException(EX.API_REQUEST_FAILED, `${fieldName} 处理失败: ${error.message}`);
      }
    }
```

**Step 2: 运行类型检查**

```bash
npm run type-check
```

期望：无错误

**Step 3: 提交**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: implement audio upload loop in omni_reference mode"
```

---

### Task 5: 更新 material_list 构建逻辑并修复 benefit_type

**Files:**
- Modify: `src/api/controllers/videos.ts`（约第 472-548 行）

**Step 1: 在 material_list 构建循环中增加 audio 分支（第 492-511 行）**

当前 `for` 循环结构：
```typescript
for (const entry of orderedEntries) {
  if (entry.type === "image") {
    // ... image 处理
    materialTypes.push(1);
  } else {
    // ... video 处理（原有 else 分支）
    materialTypes.push(2);
  }
}
```

将 `else` 分支改为 `else if` + 新增 `else`（音频）：
```typescript
for (const entry of orderedEntries) {
  if (entry.type === "image") {
    material_list.push({
      type: "",
      id: util.uuid(),
      material_type: "image",
      image_info: {
        type: "image",
        id: util.uuid(),
        source_from: "upload",
        platform_type: 1,
        name: "",
        image_uri: entry.imageUri,
        width: 0,
        height: 0,
        format: "",
        uri: entry.imageUri,
      },
    });
    materialTypes.push(1);
  } else if (entry.type === "video") {
    const vm = entry.videoResult!;
    material_list.push({
      type: "",
      id: util.uuid(),
      material_type: "video",
      video_info: {
        type: "video",
        id: util.uuid(),
        source_from: "upload",
        name: "",
        vid: vm.vid,
        fps: 0,
        width: vm.videoMeta.width,
        height: vm.videoMeta.height,
        duration: Math.round(vm.videoMeta.duration * 1000),
      },
    });
    materialTypes.push(2);
  } else {
    const am = entry.audioResult!;
    material_list.push({
      type: "",
      id: util.uuid(),
      material_type: "audio",
      audio_info: {
        type: "audio",
        id: util.uuid(),
        source_from: "upload",
        vid: am.vid,
        duration: am.duration,
        name: am.name || entry.originalFilename || "",
      },
    });
    materialTypes.push(3);
  }
}
```

**Step 2: 修复 benefit_type 动态调整（第 548 行）**

将：
```typescript
// 根据模型选择 benefit_type
const omniBenefitType = is40 ? OMNI_BENEFIT_TYPE_FAST : OMNI_BENEFIT_TYPE;
```

改为：
```typescript
// 根据模型和素材类型选择 benefit_type
const omniBenefitTypeBase = is40 ? OMNI_BENEFIT_TYPE_FAST : OMNI_BENEFIT_TYPE;
const hasVideoMaterial = orderedEntries.some(e => e.type === "video");
const omniBenefitType = hasVideoMaterial ? `${omniBenefitTypeBase}_with_video` : omniBenefitTypeBase;
```

**Step 3: 运行类型检查**

```bash
npm run type-check
```

期望：无错误

**Step 4: 提交**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: add audio to material_list and fix benefit_type with_video"
```

---

### Task 6: 更新路由验证

**Files:**
- Modify: `src/api/routes/videos.ts`（omni_reference 验证段，约第 88-132 行）

**Step 1: 在 omni_reference 验证段中新增 audioCount 统计**

在当前 `videoCount` 统计之后（第 113 行之后），`totalCount` 计算之前，插入：

```typescript
// 统计音频文件
let audioCount = 0;
for (let i = 1; i <= 2; i++) {
  const fieldName = `audio_file_${i}`;
  if (uploadedFiles[fieldName]) {
    audioCount++;
  } else if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) {
    audioCount++;
  }
}
if (audioCount > 2) {
  throw new Error('全能模式最多上传2个音频文件');
}
```

**Step 2: 更新 totalCount 计算（第 123 行）**

将：
```typescript
const totalCount = imageCount + videoCount;
```

改为：
```typescript
const totalCount = imageCount + videoCount + audioCount;
```

**Step 3: 更新"至少一个素材"的错误消息（第 130-131 行）**

将：
```typescript
throw new Error('全能模式至少需要上传1个素材文件(图片或视频)');
```

改为：
```typescript
throw new Error('全能模式至少需要上传1个素材文件(图片、视频或音频)');
```

**Step 4: 运行类型检查**

```bash
npm run type-check
```

期望：无错误

**Step 5: 提交**

```bash
git add src/api/routes/videos.ts
git commit -m "feat: add audio_file_* validation to omni_reference route"
```

---

### Task 7: 验证与测试

**Step 1: 构建项目确认无编译错误**

```bash
npm run build
```

期望：`dist/` 目录生成，无报错

**Step 2: 检查是否需要创建手动测试脚本**

在 `test-manual/` 目录下创建 `test-omni-audio.sh`：

```bash
#!/bin/bash
# 测试 omni_reference 模式音频支持
# 用法: TOKEN=your_token ./test-omni-audio.sh

BASE_URL="http://localhost:5100"
TOKEN="${TOKEN:-your_session_token_here}"

echo "=== 测试1: 图片 + 音频混合 ==="
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
echo "=== 测试2: 音频URL引用 ==="
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
```

**Step 3: 启动开发服务器**

```bash
npm run dev
```

**Step 4: 如有实际 Token，执行手动测试**

```bash
TOKEN=your_actual_token bash test-manual/test-omni-audio.sh
```

观察日志输出中是否出现：
- `[omni] 上传 audio_file_1`
- `[omni] audio_file_1 上传成功: vid=...`
- `[omni] material_list: N 项` （N 应包含音频条目）

**Step 5: 最终提交测试脚本**

```bash
git add test-manual/test-omni-audio.sh
git commit -m "test: add manual test script for omni_reference audio support"
```

---

## 总结

完成后的改动：
- `src/lib/video-uploader.ts`: 新增 `AudioUploadResult` + `uploadAudioBuffer` + `uploadAudioFromUrl`
- `src/api/controllers/videos.ts`: `MaterialEntry` 扩展、音频字段检测、音频上传循环、`audio_info` material 构建、benefit_type 修复
- `src/api/routes/videos.ts`: `audio_file_*` 验证
- `test-manual/test-omni-audio.sh`: 手动测试脚本
