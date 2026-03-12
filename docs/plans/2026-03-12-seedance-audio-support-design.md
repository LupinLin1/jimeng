# Seedance 模型音频参考支持设计文档

**日期**: 2026-03-12
**状态**: 已批准
**参考**: https://github.com/wwwzhouhui/jimeng-free-api-all

## 背景

当前 `omni_reference` 模式（仅限 seedance 2.0/2.0-fast 模型）已支持图片（`image_file_*`）和视频（`video_file_*`）素材混合输入。本次新增音频文件（`audio_file_*`）支持，使用场景为：用户同时提供图片/视频作为视觉素材 + 音频作为声音参考，一并生成视频。

同时修复一个现有 bug：当 `omni_reference` 模式包含视频素材时，`benefit_type` 应动态追加 `_with_video` 后缀，但当前实现未做此调整。

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `src/lib/video-uploader.ts` | 新增音频上传函数 |
| `src/api/controllers/videos.ts` | omni_reference 分支增加音频处理 |
| `src/api/routes/videos.ts` | 新增 audio_file_* 字段验证 |

## API 变更

### 新增字段（仅 `omni_reference` 模式）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `audio_file_1` | 文件上传 或 HTTP URL 字符串 | 第一个音频素材 |
| `audio_file_2` | 文件上传 或 HTTP URL 字符串 | 第二个音频素材（可选）|

- Prompt 中用 `@audio_file_1`、`@audio_file_2` 引用音频
- 最多 2 个音频文件
- 支持格式：`.mp3`、`.wav`、`.m4a`
- 可与 `image_file_*`、`video_file_*` 混合使用

## 数据结构

### AudioUploadResult（新增）

```typescript
export interface AudioUploadResult {
  vid: string;
  duration: number;  // 毫秒
  name: string;
}
```

### MaterialEntry 扩展

```typescript
interface MaterialEntry {
  idx: number;
  type: "image" | "video" | "audio";   // 新增 "audio"
  fieldName: string;
  originalFilename: string;
  imageUri?: string;
  videoResult?: VideoUploadResult;
  audioResult?: AudioUploadResult;      // 新增
}
```

### material_list 音频条目

```json
{
  "type": "",
  "id": "<uuid>",
  "material_type": "audio",
  "audio_info": {
    "type": "audio",
    "id": "<uuid>",
    "source_from": "upload",
    "vid": "<VOD vid>",
    "duration": 30000,
    "name": "background.mp3"
  }
}
```

### materialTypes 编码

```
image → 1（已有）
video → 2（已有）
audio → 3（新增）
```

### benefit_type 动态调整（bug 修复）

```typescript
const hasVideoMaterial = orderedEntries.some(e => e.type === "video");
const finalBenefitType = hasVideoMaterial
  ? `${omniBenefitType}_with_video`
  : omniBenefitType;
```

## 实现细节

### 1. src/lib/video-uploader.ts

新增两个函数，复用现有 VOD 上传流程（ApplyUploadInner → Upload → CommitUploadInner）：

```typescript
export async function uploadAudioBuffer(
  audioBuffer: ArrayBuffer | Buffer,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<AudioUploadResult>

export async function uploadAudioFromUrl(
  audioUrl: string,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<AudioUploadResult>
```

与视频上传的差异：音频不校验时长上限（无 15s 限制）。

### 2. src/api/controllers/videos.ts（omni_reference 分支）

在现有 `imageFields` / `videoFields` 检测后，新增 `audioFields` 检测：
- 检测 `files` 中的 `audio_file_1`、`audio_file_2`
- 检测 `httpRequest.body` 中的 `audio_file_1`、`audio_file_2` URL 字段

`canonicalKeys` 集合扩展：
```typescript
for (let i = 1; i <= 2; i++) canonicalKeys.add(`audio_file_${i}`);
```

串行上传音频后，在 `material_list` 构建阶段增加 `audio_info` 条目处理分支。

### 3. src/api/routes/videos.ts（omni_reference 验证）

```typescript
let audioCount = 0;
for (let i = 1; i <= 2; i++) {
  const fieldName = `audio_file_${i}`;
  if (uploadedFiles[fieldName]) audioCount++;
  else if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) audioCount++;
}
if (audioCount > 2) throw new Error('全能模式最多上传2个音频文件');
const totalCount = imageCount + videoCount + audioCount;
if (totalCount > 12) throw new Error('全能模式素材总数不超过12个');
```

## 数据流

```
请求 → 路由验证（含 audio_file_* 计数）
     → generateVideo() omni_reference 分支
       → 检测 audio_file_1/2 字段（文件或 URL）
       → uploadAudioBuffer / uploadAudioFromUrl → 获取 vid + duration
       → 注册到 materialRegistry（canonical key + alias）
       → 构建 audio_info material_list 条目
       → parseOmniPrompt 解析 @audio_file_* → meta_list（meta_type: "audio"）
       → materialTypes 包含 3（音频代码）
       → benefit_type 动态追加 _with_video（如含视频素材）
     → 通过浏览器代理发送请求到即梦 API
```

## 约束

- 音频支持仅限 `omni_reference` 模式（seedance 2.0 / 2.0-fast）
- 最多 2 个音频文件
- 素材总数（图+视+音）不超过 12 个
- 音频需通过 VOD 上传，不支持直接传 URL 给即梦 API
