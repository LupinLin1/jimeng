# 视频生成异步API设计文档

**日期**: 2025-02-25
**状态**: 设计阶段
**作者**: Claude Code

## 1. 概述

### 1.1 背景

当前 jimeng-api 的视频生成功能 (`POST /v1/videos/generations`) 采用同步模式,客户端需要等待视频生成完成(可能需要数分钟)才能获得响应。这种方式存在以下问题:

- **超时风险**: HTTP 请求可能超时
- **资源占用**: 长连接占用服务器资源
- **用户体验差**: 客户端需要长时间等待无响应

### 1.2 目标

将视频生成 API 改为异步模式,客户端可以:
1. 提交任务后立即获得任务ID
2. 通过任务ID轮询查询生成状态
3. 获取生成结果

### 1.3 设计原则

- **最小化改动**: 复用即梦原生的任务系统,不引入新的实体类
- **无状态**: 不维护本地任务存储,所有状态从即梦 API 查询
- **向后兼容**: 保留同步模式选项(内部使用)

## 2. 架构设计

### 2.1 核心思路

即梦 AI 已经有完整的任务系统:
- `history_record_id`: 任务唯一标识
- `/mweb/v1/get_history_by_ids`: 查询任务状态的 API
- 状态码系统: 标识任务的不同阶段

**不做新的任务管理系统**,直接利用即梦的原生机制。

### 2.2 架构图

```
┌─────────┐                    ┌────────────┐                  ┌──────────┐
│ 客户端  │                    │ jimeng-api │                  │ 即梦API  │
└────┬────┘                    └─────┬──────┘                  └────┬─────┘
     │                               │                              │
     │ POST /v1/videos/generations   │                              │
     ├──────────────────────────────>│                              │
     │                               │ POST /mweb/v1/aigc_draft/   │
     │                               │ generate                    │
     │                               ├─────────────────────────────>│
     │                               │                              │
     │                               │ {history_record_id: "xxx"}  │
     │                               │<─────────────────────────────┤
     │                               │                              │
     │ {task_id: "xxx", status:pending}                             │
     │<──────────────────────────────┤                              │
     │                               │                              │
     │                               │   (后台处理中...)              │
     │                               │                              │
     │ GET /v1/videos/tasks/xxx      │                              │
     ├──────────────────────────────>│                              │
     │                               │ POST /mweb/v1/get_history_by_ids
     │                               ├─────────────────────────────>│
     │                               │                              │
     │                               │ {status: 20, item_list: []} │
     │                               │<─────────────────────────────┤
     │                               │                              │
     │ {status: "processing", ...}   │                              │
     │<──────────────────────────────┤                              │
     │                               │                              │
     │ GET /v1/videos/tasks/xxx      │                              │
     ├──────────────────────────────>│                              │
     │                               │ (再次查询...)                 │
     │                               ├─────────────────────────────>│
     │                               │                              │
     │                               │ {status: 50, item_list: [{video_url: "..."}]}
     │                               │<─────────────────────────────┤
     │                               │                              │
     │ {status: "completed", url: "..."}                             │
     │<──────────────────────────────┤                              │
```

### 2.3 状态流转

```
pending → processing → completed
                      → failed
```

## 3. API 设计

### 3.1 提交视频生成任务

**端点**: `POST /v1/videos/generations`

**请求**: 保持现有格式不变

**响应** (异步模式):
```json
{
  "created": 1737830400,
  "task_id": "7535099487211244578",
  "status": "pending"
}
```

### 3.2 查询任务状态

**端点**: `GET /v1/videos/tasks/:task_id`

**路径参数**:
- `task_id`: 即梦的 `history_record_id`

**响应** (处理中):
```json
{
  "task_id": "7535099487211244578",
  "status": "processing",
  "progress": 50,
  "message": "视频生成中"
}
```

**响应** (完成):
```json
{
  "task_id": "7535099487211244578",
  "status": "completed",
  "progress": 100,
  "result": {
    "url": "https://example.com/video.mp4"
  }
}
```

**响应** (失败):
```json
{
  "task_id": "7535099487211244578",
  "status": "failed",
  "error": "积分不足",
  "error_code": "5000"
}
```

**响应** (任务不存在):
- HTTP 状态码: `404`
- ```json
  {
    "error": "任务不存在或已过期"
  }
  ```

## 4. 数据结构

### 4.1 任务状态枚举

| 状态 | 说明 | 对应即梦状态码 |
|------|------|----------------|
| `pending` | 任务已提交,等待处理 | - |
| `processing` | 处理中 | 20, 42, 45 |
| `completed` | 生成成功 | 10, 50 |
| `failed` | 生成失败 | 30 |
| `not_found` | 任务不存在 | - |

### 4.2 即梦状态码映射

| 状态码 | 名称 | 说明 | 映射状态 | 进度 |
|--------|------|------|----------|------|
| 20 | PROCESSING | 处理中 | processing | 50% |
| 42 | POST_PROCESSING | 后处理中 | processing | 80% |
| 45 | FINALIZING | 最终处理 | processing | 90% |
| 10 | SUCCESS | 成功 | completed | 100% |
| 30 | FAILED | 失败 | failed | - |
| 50 | COMPLETED | 已完成 | completed | 100% |

### 4.3 进度计算逻辑

```typescript
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
```

### 4.4 错误码映射

| 错误码 | 说明 | 处理方式 |
|--------|------|----------|
| 5000 | 积分不足 | 返回友好提示 |
| 2003 | 内容违规 | 返回友好提示 |
| 其他 | 未知错误 | 返回错误码和描述 |

## 5. 实现细节

### 5.1 修改 generateVideo 函数

**文件**: `src/api/controllers/videos.ts`

**新增参数**:
```typescript
{
  // ... 现有参数
  waitCompletion?: boolean  // 是否等待完成(默认 false)
}
```

**逻辑修改**:
```typescript
// 发送请求到即梦,获取 history_record_id
const { aigc_data } = aigcData;
const historyId = aigc_data.history_record_id;

// 如果不需要等待完成,立即返回 task_id
if (!options.waitCompletion) {
  return {
    task_id: historyId,
    status: 'pending'
  };
}

// 否则,继续现有的轮询逻辑(向后兼容)
const poller = new SmartPoller({ ... });
// ...
```

### 5.2 新增查询函数

**文件**: `src/api/controllers/videos.ts`

**函数签名**:
```typescript
export async function getVideoTaskStatus(
  taskId: string,
  refreshToken: string
): Promise<VideoTaskStatus>
```

**核心逻辑**:
1. 调用即梦 `/mweb/v1/get_history_by_ids` API
2. 检查任务是否存在
3. 映射状态码到业务状态
4. 提取视频 URL
5. 计算进度

### 5.3 路由修改

**文件**: `src/api/routes/videos.ts`

**修改提交端点**:
```typescript
'/generations': async (request: Request) => {
  // ... 现有验证逻辑 ...

  const result = await generateVideo(model, prompt, {
    // ... 现有参数 ...
    waitCompletion: false  // 不等待完成
  }, token);

  return {
    created: util.unixTimestamp(),
    task_id: result.task_id,
    status: result.status
  };
}
```

**新增查询端点**:
```typescript
get: {
  '/tasks/:taskId': async (request: Request) => {
    const { taskId } = request.params;
    const token = _.sample(tokenSplit(request.headers.authorization));

    const status = await getVideoTaskStatus(taskId, token);

    if (status.status === 'not_found') {
      throw new APIException(EX.API_NOT_FOUND, '任务不存在或已过期');
    }

    return status;
  }
}
```

### 5.4 错误处理

**任务不存在**:
- 返回 HTTP 404
- 错误信息: "任务不存在或已过期"

**任务失败**:
- 映射即梦错误码到友好提示
- 返回 `error_code` 和 `error` 字段

**网络错误**:
- 复用现有的重试机制
- 复用 `error-handler.ts` 的错误处理逻辑

## 6. 文件结构

```
src/
├── api/
│   ├── controllers/
│   │   └── videos.ts              # 修改: generateVideo, 新增 getVideoTaskStatus
│   └── routes/
│       └── videos.ts              # 修改: /generations, 新增 /tasks/:taskId
```

**修改文件清单**:
- `src/api/controllers/videos.ts`: 核心逻辑修改
- `src/api/routes/videos.ts`: 路由修改

**新增文件**: 无

## 7. 测试计划

### 7.1 单元测试

- `getVideoTaskStatus` 函数测试
  - 任务不存在
  - 任务处理中
  - 任务完成
  - 任务失败

### 7.2 集成测试

- 提交任务 → 获取 task_id
- 查询任务状态 → 验证状态流转
- 等待任务完成 → 获取视频 URL

### 7.3 边界测试

- 查询不存在的 task_id
- 查询已过期的 task_id
- 并发查询同一个任务

## 8. 部署注意事项

### 8.1 向后兼容性

**破坏性变更**:
- 响应格式完全改变
- 所有客户端需要修改为异步模式

**建议**:
- 发布新版本号: `v2.0.0`
- 在 README 和变更日志中明确标注
- 提供迁移指南

### 8.2 依赖

- 无新增依赖
- 复用现有的即梦 API 调用逻辑

### 8.3 性能考虑

- **无状态**: 每次查询都调用即梦 API,注意请求频率
- **缓存**: 不需要缓存,因为查询的是实时状态

## 9. 未来优化方向

### 9.1 Webhook 支持

如果即梦支持,可以考虑添加 Webhook 回调功能,避免客户端轮询。

### 9.2 批量查询

支持批量查询多个任务状态:
```
GET /v1/videos/tasks?ids=xxx,yyy,zzz
```

### 9.3 进度详情

如果即梦提供更详细的进度信息,可以返回更精细的进度(如"正在渲染第3秒/共5秒")。

## 10. 参考资料

- 即梦视频生成流程: `src/api/controllers/videos.ts:157-1005`
- 智能轮询器: `src/lib/smart-poller.ts`
- 即梦 API 请求封装: `src/api/controllers/core.ts`
- 错误处理: `src/lib/error-handler.ts`
