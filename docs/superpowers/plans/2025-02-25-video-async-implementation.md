# 视频生成异步API实施计划

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 将视频生成API从同步模式改为异步模式,允许客户端提交任务后立即获得task_id,通过查询端点获取生成状态和结果

**架构:** 复用即梦原生的任务系统(history_record_id),不维护本地状态,查询时直接调用即梦API获取实时状态

**技术栈:** TypeScript + Koa,复用现有的请求封装和错误处理机制

---

## 文件结构

本实施计划将修改以下文件:

1. **src/api/controllers/videos.ts** (修改)
   - 修改 `generateVideo` 函数:添加 `waitCompletion` 参数,支持立即返回模式
   - 新增 `getVideoTaskStatus` 函数:查询任务状态
   - 新增 `calculateProgress` 辅助函数:计算任务进度
   - 新增 `mapStatusToApi` 辅助函数:映射即梦状态码到API状态

2. **src/api/routes/videos.ts** (修改)
   - 修改 `/generations` 端点:设置 `waitCompletion: false`
   - 新增 GET `/tasks/:taskId` 端点:查询任务状态

**不新增文件**,保持最小化改动原则。

---

## Chunk 1: 修改 generateVideo 函数支持异步模式

### Task 1: 修改 generateVideo 函数签名

**文件:**
- Modify: `src/api/controllers/videos.ts:157-178`

- [ ] **Step 1: 在 options 接口中添加 waitCompletion 参数**

在 `generateVideo` 函数的 options 参数接口中添加 `waitCompletion` 可选参数,默认值为 `false`:

```typescript
export async function generateVideo(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = {},
    httpRequest,
    functionMode = "first_last_frames",
    waitCompletion = false,  // 新增:默认不等待完成
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any;
    httpRequest?: any;
    functionMode?: string;
    waitCompletion?: boolean;  // 新增
  },
  refreshToken: string
)
```

- [ ] **Step 2: 提交更改**

```bash
git add src/api/controllers/videos.ts
git commit -m "refactor: add waitCompletion parameter to generateVideo

Add optional waitCompletion parameter (default false) to support
async video generation mode. When false, function returns immediately
with task_id instead of waiting for completion."
```

### Task 2: 在 generateVideo 中实现提前返回逻辑

**文件:**
- Modify: `src/api/controllers/videos.ts:895-905`

- [ ] **Step 1: 在获取 history_id 后添加提前返回逻辑**

在 `const historyId = aigc_data.history_record_id;` 之后,添加提前返回逻辑:

```typescript
const historyId = aigc_data.history_record_id;
if (!historyId)
  throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

// 新增: 如果不需要等待完成,立即返回 task_id
if (!waitCompletion) {
  logger.info(`视频生成任务已提交(异步模式), history_id: ${historyId}`);
  return {
    task_id: historyId,
    status: 'pending'
  };
}

logger.info(`视频生成任务已提交,history_id: ${historyId},等待生成完成...`);
```

- [ ] **Step 2: 提交更改**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: implement early return for async video generation

When waitCompletion=false (default), return immediately with task_id
instead of polling for completion. This enables async mode."
```

---

## Chunk 2: 实现任务状态查询功能

### Task 3: 实现状态码映射函数

**文件:**
- Modify: `src/api/controllers/videos.ts` (在文件末尾添加)

- [ ] **Step 1: 添加状态码映射函数**

在 `generateVideo` 函数之后,添加状态码映射辅助函数:

```typescript
/**
 * 映射即梦状态码到API状态
 */
function mapStatusToApi(status: number): 'pending' | 'processing' | 'completed' | 'failed' {
  switch (status) {
    case 20:  // PROCESSING
    case 42:  // POST_PROCESSING
    case 45:  // FINALIZING
      return 'processing';
    case 30:  // FAILED
      return 'failed';
    case 10:  // SUCCESS
    case 50:  // COMPLETED
      return 'completed';
    default:
      return 'processing';
  }
}

/**
 * 计算任务进度百分比
 */
function calculateProgress(status: number, itemList: any[]): number {
  // 已有结果,快完成了
  if (itemList.length > 0) {
    return 90;
  }

  // 根据状态码估算进度
  switch (status) {
    case 20: return 50;  // 处理中
    case 42: return 80;  // 后处理
    case 45: return 90;  // 最终处理
    default: return 30;  // 未知状态
  }
}

/**
 * 获取错误信息
 */
function getErrorMessage(failCode?: string): string {
  if (!failCode) return '生成失败';

  const errorMap: Record<string, string> = {
    '5000': '积分不足',
    '2003': '内容违规',
  };

  return errorMap[failCode] || `生成失败 (错误码: ${failCode})`;
}
```

- [ ] **Step 2: 提交更改**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: add status mapping helper functions

Add mapStatusToApi, calculateProgress, and getErrorMessage
helper functions for converting Jimeng status codes to
API-friendly format."
```

### Task 4: 实现 getVideoTaskStatus 函数

**文件:**
- Modify: `src/api/controllers/videos.ts` (在辅助函数之后添加)

- [ ] **Step 1: 实现 getVideoTaskStatus 函数**

```typescript
/**
 * 查询视频生成任务状态
 *
 * @param taskId 任务ID (即梦的 history_record_id)
 * @param refreshToken 刷新令牌
 * @returns 任务状态信息
 */
export async function getVideoTaskStatus(
  taskId: string,
  refreshToken: string
): Promise<{
  task_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_found';
  progress?: number;
  result?: { url: string };
  error?: string;
  error_code?: string;
}> {
  try {
    // 调用即梦 API 查询状态
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [taskId],
      },
    });

    const historyData = result[taskId];

    // 任务不存在
    if (!historyData) {
      logger.warn(`任务不存在: ${taskId}`);
      return {
        task_id: taskId,
        status: 'not_found'
      };
    }

    const status = historyData.status;
    const failCode = historyData.fail_code;
    const itemList = historyData.item_list || [];

    logger.info(`任务状态查询: ${taskId}, 即梦状态: ${status}, 失败码: ${failCode || 'none'}, 结果数: ${itemList.length}`);

    // 失败状态
    if (status === 30) {
      return {
        task_id: taskId,
        status: 'failed',
        error: getErrorMessage(failCode),
        error_code: failCode
      };
    }

    // 成功状态
    if (status === 10 || status === 50) {
      // 提取视频URL
      let videoUrl: string | null = null;

      if (itemList.length > 0) {
        const item = itemList[0];

        // 尝试多种URL字段
        videoUrl = item.video?.transcoded_video?.origin?.video_url ||
                   item.video?.play_url ||
                   item.video?.download_url ||
                   item.video?.url;
      }

      if (videoUrl) {
        return {
          task_id: taskId,
          status: 'completed',
          progress: 100,
          result: {
            url: videoUrl
          }
        };
      } else {
        // 状态已完成但无URL,可能是最终处理中
        return {
          task_id: taskId,
          status: 'processing',
          progress: 95,
          error: '视频生成完成,正在提取URL'
        };
      }
    }

    // 处理中
    const progress = calculateProgress(status, itemList);
    return {
      task_id: taskId,
      status: 'processing',
      progress
    };

  } catch (error: any) {
    logger.error(`查询任务状态失败: ${taskId}, 错误: ${error.message}`);

    // 网络错误时不认为是任务不存在,返回处理中状态
    return {
      task_id: taskId,
      status: 'processing',
      progress: 0,
      error: `查询失败: ${error.message}`
    };
  }
}
```

- [ ] **Step 2: 提交更改**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: implement getVideoTaskStatus function

Add function to query video generation task status from Jimeng API.
Returns task status, progress, result URL, or error information.
Handles all status codes and error conditions."
```

---

## Chunk 3: 修改路由端点

### Task 5: 修改 /generations 端点为异步模式

**文件:**
- Modify: `src/api/routes/videos.ts:164-178`

- [ ] **Step 1: 修改 generateVideo 调用,设置 waitCompletion 为 false**

找到 `generateVideo` 调用处,添加 `waitCompletion: false` 参数:

```typescript
// 生成视频
const generationResult = await generateVideo(
    model,
    prompt,
    {
        ratio,
        resolution,
        duration: finalDuration,
        filePaths: finalFilePaths,
        files: request.files,
        httpRequest: request,
        functionMode,
        waitCompletion: false,  // 新增:不等待完成
    },
    token
);

// 返回任务ID
return {
    created: util.unixTimestamp(),
    task_id: generationResult.task_id,
    status: generationResult.status
};
```

同时需要修改返回逻辑,删除原来的 `response_format` 处理代码(因为异步模式没有立即返回视频URL)。

- [ ] **Step 2: 提交更改**

```bash
git add src/api/routes/videos.ts
git commit -m "feat: convert /generations endpoint to async mode

Set waitCompletion=false to return immediately with task_id.
Remove response_format handling since async mode doesn't
return video URL immediately."
```

### Task 6: 添加 /tasks/:taskId 查询端点

**文件:**
- Modify: `src/api/routes/videos.ts` (在 post 对象之后添加 get 对象)

- [ ] **Step 1: 添加 GET 路由对象**

在 `export default` 对象中添加 `get` 属性:

```typescript
import { getVideoTaskStatus } from '@/api/controllers/videos.ts';
import EX from '@/api/consts/exceptions.ts';
import APIException from '@/lib/exceptions/APIException.ts';

export default {

    prefix: '/v1/videos',

    post: {
        // ... 现有的 /generations 端点 ...
    },

    // 新增: GET 路由
    get: {
        '/tasks/:taskId': async (request: Request) => {
            // 验证 task_id 参数
            request.validate('params.taskId', _.isString);

            const { taskId } = request.params;

            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const token = _.sample(tokens);

            if (!token) {
                throw new APIException(EX.API_UNAUTHORIZED, '未提供认证令牌');
            }

            // 查询任务状态
            const status = await getVideoTaskStatus(taskId, token);

            // 任务不存在
            if (status.status === 'not_found') {
                throw new APIException(EX.API_NOT_FOUND, '任务不存在或已过期');
            }

            return status;
        }
    }
}
```

- [ ] **Step 2: 确保必要的 import 语句存在**

检查文件顶部是否有以下 import:
```typescript
import { getVideoTaskStatus } from '@/api/controllers/videos.ts';
import EX from '@/api/consts/exceptions.ts';
import APIException from '@/lib/exceptions/APIException.ts';
```

如果没有,添加到文件顶部的 import 区域。

- [ ] **Step 3: 提交更改**

```bash
git add src/api/routes/videos.ts
git commit -m "feat: add GET /v1/videos/tasks/:taskId endpoint

Add endpoint to query video generation task status.
Returns task status, progress, result URL, or error information.
Throws 404 when task not found or expired."
```

---

## Chunk 4: 测试和验证

### Task 7: 类型检查

- [ ] **Step 1: 运行 TypeScript 类型检查**

```bash
npm run type-check
```

预期: 无类型错误

如果有类型错误,修复后重新检查。

- [ ] **Step 2: 提交修复(如果有)**

```bash
git add -A
git commit -m "fix: resolve type checking errors"
```

### Task 8: 手动功能测试

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 测试提交任务**

使用 curl 测试提交视频生成任务:

```bash
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d '{
    "model": "jimeng-video-3.0",
    "prompt": "一只猫在玩毛线球",
    "ratio": "16:9"
  }'
```

预期响应:
```json
{
  "created": 1737830400,
  "task_id": "7535099487211244578",
  "status": "pending"
}
```

记录返回的 `task_id`。

- [ ] **Step 3: 测试查询任务状态(处理中)**

立即查询任务状态:

```bash
curl http://localhost:5100/v1/videos/tasks/YOUR_TASK_ID \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

预期响应:
```json
{
  "task_id": "7535099487211244578",
  "status": "processing",
  "progress": 50
}
```

- [ ] **Step 4: 测试查询任务状态(完成)**

等待1-2分钟后,再次查询:

```bash
curl http://localhost:5100/v1/videos/tasks/YOUR_TASK_ID \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

预期响应(完成):
```json
{
  "task_id": "7535099487211244578",
  "status": "completed",
  "progress": 100,
  "result": {
    "url": "https://..."
  }
}
```

- [ ] **Step 5: 测试查询不存在的任务**

```bash
curl http://localhost:5100/v1/videos/tasks/invalid_task_id \
  -H "Authorization: Bearer YOUR_SESSION_ID"
```

预期: HTTP 404,响应体:
```json
{
  "error": "任务不存在或已过期"
}
```

- [ ] **Step 6: 记录测试结果**

将测试结果记录到项目根目录的 `TEST_RESULTS.md`:

```markdown
# 视频异步API测试结果

**日期**: 2025-02-25

## 测试用例

### 1. 提交任务
- [ ] 通过: 返回 task_id 和 status=pending
- 备注:

### 2. 查询任务(处理中)
- [ ] 通过: 返回 status=processing, progress=50
- 备注:

### 3. 查询任务(完成)
- [ ] 通过: 返回 status=completed, result.url
- 备注:

### 4. 查询不存在的任务
- [ ] 通过: 返回 HTTP 404
- 备注:
```

- [ ] **Step 7: 提交测试结果**

```bash
git add TEST_RESULTS.md
git commit -m "test: add manual test results for async video API"
```

---

## Chunk 5: 文档更新

### Task 9: 更新 README

- [ ] **Step 1: 更新 README.md API 端点文档**

在 README.md 的 API 端点部分,更新视频生成相关文档:

```markdown
## 视频生成

### 提交视频生成任务 (异步)

**端点**: `POST /v1/videos/generations`

**请求**:
\`\`\`json
{
  "model": "jimeng-video-3.0",
  "prompt": "提示词",
  "ratio": "16:9",
  "duration": 5
}
\`\`\`

**响应**:
\`\`\`json
{
  "created": 1737830400,
  "task_id": "7535099487211244578",
  "status": "pending"
}
\`\`\`

### 查询视频生成任务状态

**端点**: `GET /v1/videos/tasks/:task_id`

**响应** (处理中):
\`\`\`json
{
  "task_id": "7535099487211244578",
  "status": "processing",
  "progress": 50
}
\`\`\`

**响应** (完成):
\`\`\`json
{
  "task_id": "7535099487211244578",
  "status": "completed",
  "progress": 100,
  "result": {
    "url": "https://..."
  }
}
\`\`\`

**响应** (失败):
\`\`\`json
{
  "task_id": "7535099487211244578",
  "status": "failed",
  "error": "积分不足",
  "error_code": "5000"
}
\`\`\`

**响应** (任务不存在):
- HTTP 状态码: 404
\`\`\`json
{
  "error": "任务不存在或已过期"
}
\`\`\`

**状态说明**:
- `pending`: 任务已提交
- `processing`: 处理中 (progress: 0-99)
- `completed`: 生成成功
- `failed`: 生成失败
```

- [ ] **Step 2: 在 README 顶部添加版本变更说明**

在 README.md 顶部添加:

```markdown
> **⚠️ Breaking Change (v2.0.0)**: 视频生成 API 已改为异步模式。旧版本的同步模式已移除。请参考下方文档了解新的异步使用方式。
```

- [ ] **Step 3: 提交文档更新**

```bash
git add README.md
git commit -m "docs: update README for async video API

Add documentation for new async video generation API.
Document both submit and status query endpoints.
Add breaking change notice for v2.0.0."
```

### Task 10: 更新 package.json 版本号

- [ ] **Step 1: 更新版本号到 2.0.0**

修改 `package.json`:

```json
{
  "name": "jimeng-api",
  "version": "2.0.0",
  ...
}
```

- [ ] **Step 2: 提交版本更新**

```bash
git add package.json
git commit -m "chore: bump version to 2.0.0

Major version bump for breaking change:
Video generation API is now async by default."
```

---

## Chunk 6: 最终检查和发布

### Task 11: 最终验证

- [ ] **Step 1: 完整构建测试**

```bash
npm run build
```

预期: 构建成功,无错误

- [ ] **Step 2: 运行所有检查**

```bash
npm run type-check && npm run format
```

预期: 无错误

- [ ] **Step 3: 查看变更摘要**

```bash
git diff main --stat
```

确认所有变更都在预期范围内。

- [ ] **Step 4: 创建 git tag**

```bash
git tag -a v2.0.0 -m "Release v2.0.0: Async Video Generation API

Breaking Changes:
- Video generation API now uses async mode by default
- POST /v1/videos/generations returns task_id immediately
- New GET /v1/videos/tasks/:taskId endpoint for status polling

Features:
- Added task status query endpoint
- Real-time progress tracking
- Error code mapping for better error messages

Documentation:
- Updated README with async API usage
- Added migration guide"
```

### Task 12: 推送到远程仓库

- [ ] **Step 1: 推送代码和标签**

```bash
git push origin main
git push origin v2.0.0
```

- [ ] **Step 2: 在 GitHub 创建 Release**

1. 访问 GitHub 仓库的 Releases 页面
2. 点击 "Draft a new release"
3. 选择标签 `v2.0.0`
4. Release title: `v2.0.0 - 异步视频生成API`
5. Release 内容:

```markdown
## 主要变更

### ⚠️ 破坏性变更

视频生成 API 已改为**异步模式**:

- **旧版本**: 请求会阻塞等待视频生成完成
- **新版本**: 请求立即返回 `task_id`,需要轮询查询状态

### 新增功能

- ✅ 新增 `GET /v1/videos/tasks/:task_id` 端点用于查询任务状态
- ✅ 支持实时进度查询 (0-100%)
- ✅ 友好的错误信息映射

### 迁移指南

**旧版本**:
\`\`\`bash
curl -X POST /v1/videos/generations -d '{...}' # 阻塞等待,返回视频URL
\`\`\`

**新版本**:
\`\`\`bash
# 1. 提交任务
curl -X POST /v1/videos/generations -d '{...}' # 立即返回 task_id

# 2. 轮询查询状态
curl /v1/videos/tasks/{task_id} # 返回状态和进度

# 3. 等待完成后获取视频URL
curl /v1/videos/tasks/{task_id} # status=completed 时返回 result.url
\`\`\`

详细文档请参考: [README.md](链接)

## 其他改进

- 优化错误处理和错误信息
- 改进日志输出
```

6. 点击 "Publish release"

---

## 完成检查清单

实施完成后,确认以下所有项都已完成:

- [ ] `generateVideo` 函数支持 `waitCompletion` 参数
- [ ] 默认使用异步模式 (`waitCompletion=false`)
- [ ] 实现 `getVideoTaskStatus` 函数
- [ ] 添加状态码映射辅助函数
- [ ] 修改 `/generations` 端点返回 task_id
- [ ] 新增 `/tasks/:taskId` 查询端点
- [ ] 类型检查通过 (`npm run type-check`)
- [ ] 手动测试所有端点通过
- [ ] 更新 README 文档
- [ ] 更新版本号到 2.0.0
- [ ] 创建 git tag 和 GitHub Release
- [ ] 所有更改已提交到 git

---

## 注意事项

1. **向后兼容**: 这是一个破坏性变更,所有使用视频生成API的客户端都需要更新

2. **错误处理**: 即梦 API 可能会调整错误码,需要关注并更新 `getErrorMessage` 函数

3. **任务过期**: 即梦可能会清理历史任务,过期的任务查询会返回 404

4. **轮询频率**: 建议客户端每隔 2-5 秒查询一次状态,避免频繁请求

5. **测试环境**: 测试时需要有效的即梦 session_id,确保积分充足

---

## 参考资料

- 设计文档: `docs/superpowers/specs/2025-02-25-video-async-design.md`
- 即梦 API 文档: 参考代码中的实现
- 现有轮询逻辑: `src/lib/smart-poller.ts`
