# Playwright 浏览器代理服务实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标:** 为 jimeng-api 项目集成 Playwright 浏览器代理服务,仅用于 seedance 模型请求,通过 bdms SDK 绕过 shark 反爬机制。

**架构:** 创建独立的 BrowserService 模块,在应用启动时初始化浏览器实例,为每个 sessionId 创建隔离的浏览器上下文,在浏览器环境中执行 HTTP 请求以自动获取 a_bogus 签名等反爬参数。

**技术栈:** playwright-core (v1.49.0+), TypeScript, Node.js

**参考实现:** https://github.com/wwwzhouhui/seedance2.0 (server/browser-service.js)

---

## 前置准备

### Task 1: 安装依赖

**文件:**
- Modify: `package.json`

**Step 1: 添加 playwright-core 依赖**

在 `dependencies` 中添加:
```json
"playwright-core": "^1.49.0"
```

**Step 2: 添加 Chromium 安装脚本**

在 `scripts` 中添加:
```json
"postinstall": "npx playwright-core install chromium"
```

**Step 3: 安装依赖**

Run: `npm install`

Expected: playwright-core 安装成功,Chromium 浏览器自动下载到 `node_modules/playwright-core/.local-browsers/`

**Step 4: 验证 Chromium 安装**

Run: `npx playwright-core install chromium`

Expected: 显示 Chromium 已安装或正在安装

**Step 5: 提交变更**

```bash
git add package.json package-lock.json
git commit -m "feat: add playwright-core dependency and chromium auto-install"
```

---

## 核心模块实现

### Task 2: 创建浏览器常量配置

**文件:**
- Create: `src/api/consts/browser.ts`

**Step 1: 创建浏览器配置常量文件**

```typescript
/**
 * 浏览器代理服务配置常量
 */

// 会话空闲超时时间 (毫秒)
export const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10分钟

// bdms SDK 加载超时时间 (毫秒)
export const BDMS_READY_TIMEOUT = 30000; // 30秒

// 需要阻止加载的资源类型
export const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'stylesheet', 'media'];

// 脚本白名单域名
export const SCRIPT_WHITELIST_DOMAINS = [
  'vlabstatic.com',
  'bytescm.com',
  'jianying.com',
  'byteimg.com',
];

// 用户代理
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

// 浏览器启动参数
export const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
];

// bdms SDK 加载检测超时配置
export const BDMS_CHECK_CONFIG = {
  // 最大等待时间
  timeout: BDMS_READY_TIMEOUT,
  // 轮询间隔 (毫秒)
  interval: 500,
};
```

**Step 2: 提交变更**

```bash
git add src/api/consts/browser.ts
git commit -m "feat: add browser service configuration constants"
```

---

### Task 3: 创建浏览器服务类

**文件:**
- Create: `src/lib/browser-service.ts`

**Step 1: 创建 BrowserService 类基础结构**

```typescript
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import logger from './logger.ts';
import util from './util.ts';
import {
  SESSION_IDLE_TIMEOUT,
  BDMS_READY_TIMEOUT,
  BLOCKED_RESOURCE_TYPES,
  SCRIPT_WHITELIST_DOMAINS,
  BROWSER_USER_AGENT,
  BROWSER_LAUNCH_ARGS,
} from '@/api/consts/browser.ts';

/**
 * 浏览器会话接口
 */
interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  idleTimer: NodeJS.Timeout;
}

/**
 * 浏览器代理服务
 *
 * 负责:
 * - 启动和管理 Chromium 浏览器实例
 * - 为每个 sessionId 创建隔离的浏览器上下文
 * - 在浏览器环境中执行 HTTP 请求
 * - 管理会话生命周期 (10分钟空闲超时)
 */
class BrowserService {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSession> = new Map();
  private available: boolean = false;

  /**
   * 初始化浏览器服务
   * 在应用启动时调用
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[browser] 正在启动 Chromium...');
      this.browser = await chromium.launch({
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
      });
      this.available = true;
      logger.info('[browser] Chromium 已启动');
    } catch (error: any) {
      this.available = false;
      logger.error(`[browser] 启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 确保浏览器已启动
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;

    if (!this.available) {
      throw new Error('浏览器服务不可用');
    }

    await this.initialize();
    return this.browser!;
  }

  /**
   * 获取或创建浏览器会话
   *
   * @param sessionId 用户会话ID
   * @param webId Web ID
   * @param userId 用户ID
   */
  async getSession(sessionId: string, webId: string, userId: string): Promise<BrowserSession> {
    // 检查是否已存在会话
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
      }
      existing.idleTimer = setTimeout(
        () => this.closeSession(sessionId),
        SESSION_IDLE_TIMEOUT
      );
      logger.debug(`[browser] 复用现有会话: ${sessionId.substring(0, 8)}...`);
      return existing;
    }

    // 创建新会话
    logger.info(`[browser] 创建新会话: ${sessionId.substring(0, 8)}...`);
    const browser = await this.ensureBrowser();

    // 创建浏览器上下文
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
    });

    // 注入 Cookie
    const cookies = [
      { name: '_tea_web_id', value: String(webId), domain: '.jianying.com', path: '/' },
      { name: 'is_staff_user', value: 'false', domain: '.jianying.com', path: '/' },
      { name: 'store-region', value: 'cn-gd', domain: '.jianying.com', path: '/' },
      { name: 'uid_tt', value: String(userId), domain: '.jianying.com', path: '/' },
      { name: 'sid_tt', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid_ss', value: sessionId, domain: '.jianying.com', path: '/' },
    ];
    await context.addCookies(cookies);

    // 阻止非必要资源加载
    await context.route('**/*', (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();

      if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
        return route.abort();
      }

      if (resourceType === 'script') {
        const isWhitelisted = SCRIPT_WHITELIST_DOMAINS.some((domain) =>
          url.includes(domain)
        );
        if (!isWhitelisted) return route.abort();
      }

      return route.continue();
    });

    // 创建页面
    const page = await context.newPage();

    // 导航到即梦首页
    logger.info(`[browser] 正在导航到 jimeng.jianying.com (session: ${sessionId.substring(0, 8)}...)`);
    await page.goto('https://jimeng.jianying.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 等待 bdms SDK 加载
    try {
      await page.waitForFunction(
        () => {
          return (
            (window as any).bdms?.init ||
            (window as any).byted_acrawler ||
            window.fetch.toString().indexOf('native code') === -1
          );
        },
        { timeout: BDMS_READY_TIMEOUT }
      );
      logger.info('[browser] bdms SDK 已就绪');
    } catch {
      logger.warn('[browser] bdms SDK 等待超时,继续尝试...');
    }

    // 创建会话对象
    const session: BrowserSession = {
      context,
      page,
      lastUsed: Date.now(),
      idleTimer: setTimeout(
        () => this.closeSession(sessionId),
        SESSION_IDLE_TIMEOUT
      ),
    };

    this.sessions.set(sessionId, session);
    logger.info(`[browser] 会话已创建 (session: ${sessionId.substring(0, 8)}...)`);
    return session;
  }

  /**
   * 在浏览器中执行 HTTP 请求
   *
   * @param sessionId 用户会话ID
   * @param webId Web ID
   * @param userId 用户ID
   * @param url 请求URL
   * @param options 请求选项
   */
  async fetch(
    sessionId: string,
    webId: string,
    userId: string,
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {}
  ): Promise<any> {
    const session = await this.getSession(sessionId, webId, userId);
    const { method = 'GET', headers = {}, body } = options;

    logger.info(`[browser] 通过浏览器代理请求: ${method} ${url.substring(0, 80)}...`);

    const result = await session.page.evaluate(
      async ({ url, method, headers, body }) => {
        const resp = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          credentials: 'include',
        });
        return resp.json();
      },
      { url, method, headers, body }
    );

    return result;
  }

  /**
   * 关闭指定会话
   *
   * @param sessionId 用户会话ID
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    try {
      await session.context.close();
    } catch {
      // ignore
    }

    this.sessions.delete(sessionId);
    logger.info(`[browser] 会话已关闭 (session: ${sessionId.substring(0, 8)}...)`);
  }

  /**
   * 关闭浏览器服务
   * 优雅关闭时调用
   */
  async close(): Promise<void> {
    // 关闭所有会话
    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId);
    }

    // 关闭浏览器
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
      logger.info('[browser] Chromium 已关闭');
    }

    this.available = false;
  }

  /**
   * 检查服务是否可用
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * 标记服务不可用
   */
  markUnavailable(): void {
    this.available = false;
  }
}

// 导出单例
const browserService = new BrowserService();
export default browserService;
```

**Step 2: 提交变更**

```bash
git add src/lib/browser-service.ts
git commit -m "feat: implement BrowserService class with session management"
```

---

## 集成到应用启动流程

### Task 4: 在应用启动时初始化浏览器服务

**文件:**
- Modify: `src/lib/initialize.ts`

**Step 1: 在初始化函数中添加浏览器服务启动**

找到 `export async function initialize()` 函数,在末尾添加:

```typescript
import browserService from './browser-service.ts';

export async function initialize() {
  // ... 现有初始化代码 ...

  // 初始化浏览器代理服务
  try {
    await browserService.initialize();
  } catch (error: any) {
    logger.warn(`浏览器代理服务启动失败: ${error.message}`);
    logger.warn('seedance 模型请求可能会失败,请确保 Chromium 已正确安装');
    // 不阻止应用启动
  }
}
```

**Step 2: 提交变更**

```bash
git add src/lib/initialize.ts
git commit -m "feat: initialize browser service on application startup"
```

---

### Task 5: 添加优雅关闭处理

**文件:**
- Modify: `src/lib/server.ts`

**Step 1: 在进程信号处理中添加浏览器关闭**

找到现有的 `process.on('SIGTERM')` 和 `process.on('SIGINT')` 处理器,在关闭逻辑中添加:

```typescript
import browserService from './browser-service.ts';

// SIGTERM 处理
process.on('SIGTERM', async () => {
  // ... 现有代码 ...
  await browserService.close();
  // ... 现有代码 ...
});

// SIGINT 处理
process.on('SIGINT', async () => {
  // ... 现有代码 ...
  await browserService.close();
  // ... 现有代码 ...
});
```

**Step 2: 提交变更**

```bash
git add src/lib/server.ts
git commit -m "feat: add graceful shutdown for browser service"
```

---

## 集成到视频生成流程

### Task 6: 修改视频生成控制器以使用浏览器代理

**文件:**
- Modify: `src/api/controllers/videos.ts`

**Step 1: 导入浏览器服务**

在文件顶部的导入区域添加:

```typescript
import browserService from '@/lib/browser-service.ts';
```

**Step 2: 在 generateVideo 函数中集成浏览器代理**

找到提交生成请求的代码部分,修改为:

```typescript
// 找到这行代码附近的请求逻辑
// const result = await request("POST", uri, refreshToken, { data: requestData });

// 判断是否为 seedance 模型
const isSeedanceModel = model.includes("seedance") ||
                        model.includes("40_pro") ||
                        model.includes("40");

let result: any;
if (isSeedanceModel) {
  // 使用浏览器代理
  if (!browserService.isAvailable()) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      '浏览器代理服务不可用,请确保 Chromium 已正确安装。运行: npx playwright-core install chromium'
    );
  }

  const { token: tokenWithRegion } = parseProxyFromToken(refreshToken);
  const { token } = parseRegionFromToken(tokenWithRegion);
  const sessionId = (regionInfo.isInternational)
    ? tokenWithRegion.substring(3)
    : tokenWithRegion;

  logger.info(`使用浏览器代理请求 seedance 模型: ${model}`);

  result = await browserService.fetch(
    sessionId,
    String(WEB_ID),
    USER_ID,
    fullUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestData),
    }
  );

  // 检查浏览器代理返回的结果
  if (result.ret !== undefined && String(result.ret) !== '0') {
    const retCode = String(result.ret);
    const errMsg = result.errmsg || result.message || retCode;

    // 积分不足
    if (retCode === '5000') {
      throw new APIException(EX.API_REQUEST_FAILED, '即梦积分不足,请前往即梦官网领取积分');
    }

    throw new APIException(EX.API_REQUEST_FAILED, `即梦API错误 (ret=${retCode}): ${errMsg}`);
  }

  // 浏览器代理返回的数据结构可能不同,需要提取 aigc_data
  result = result.data;
} else {
  // 使用普通 HTTP 请求
  result = await request("POST", uri, refreshToken, {
    data: requestData,
    headers: {
      Referer: referer,
    }
  });
}
```

**Step 3: 提交变更**

```bash
git add src/api/controllers/videos.ts
git commit -m "feat: integrate browser proxy for seedance model requests"
```

---

## 导出辅助函数

### Task 7: 导出 WEB_ID 和 USER_ID 常量

**文件:**
- Modify: `src/api/controllers/core.ts`

**Step 1: 导出常量**

找到这些常量的定义:
```typescript
// 设备ID
const DEVICE_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// WebID
const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// 用户ID
const USER_ID = util.uuid(false);
```

修改为:
```typescript
// 设备ID
export const DEVICE_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// WebID
export const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// 用户ID
export const USER_ID = util.uuid(false);
```

**Step 2: 提交变更**

```bash
git add src/api/controllers/core.ts
git commit -m "feat: export DEVICE_ID, WEB_ID, USER_ID constants"
```

---

### Task 8: 更新 videos.ts 导入

**文件:**
- Modify: `src/api/controllers/videos.ts`

**Step 1: 添加导出的常量到导入语句**

找到这行:
```typescript
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId, checkImageContent, RegionInfo } from "./core.ts";
```

修改为:
```typescript
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId, checkImageContent, RegionInfo, WEB_ID, USER_ID } from "./core.ts";
```

**Step 2: 提交变更**

```bash
git add src/api/controllers/videos.ts
git commit -m "fix: import WEB_ID and USER_ID from core module"
```

---

## 测试与验证

### Task 9: 浏览器服务可用性检查

**文件:**
- Create: `test/manual/browser-service.test.ts`

**Step 1: 创建手动测试脚本**

```typescript
/**
 * 浏览器服务手动测试
 *
 * 运行: npm run test:browser
 */

import browserService from '../src/lib/browser-service.ts';

async function testBrowserService() {
  console.log('=== 浏览器服务测试 ===\n');

  // 测试 1: 初始化
  console.log('测试 1: 初始化浏览器服务');
  try {
    await browserService.initialize();
    console.log('✓ 浏览器服务初始化成功\n');
  } catch (error: any) {
    console.error('✗ 浏览器服务初始化失败:', error.message);
    process.exit(1);
  }

  // 测试 2: 检查可用性
  console.log('测试 2: 检查服务可用性');
  const isAvailable = browserService.isAvailable();
  console.log(isAvailable ? '✓ 服务可用\n' : '✗ 服务不可用\n');

  // 测试 3: 创建会话 (需要有效的 sessionId)
  console.log('测试 3: 创建会话');
  console.log('提示: 需要有效的即梦 sessionId,跳过此测试\n');

  // 测试 4: 关闭服务
  console.log('测试 4: 关闭浏览器服务');
  await browserService.close();
  console.log('✓ 浏览器服务已关闭\n');

  console.log('=== 所有测试完成 ===');
}

testBrowserService().catch(console.error);
```

**Step 2: 添加测试脚本到 package.json**

```json
"scripts": {
  "test:browser": "tsx test/manual/browser-service.test.ts"
}
```

**Step 3: 安装 tsx 用于运行 TypeScript**

```bash
npm install -D tsx
```

**Step 4: 运行测试**

```bash
npm run test:browser
```

Expected: 浏览器启动并成功关闭

**Step 5: 提交变更**

```bash
git add test/manual/browser-service.test.ts package.json package-lock.json
git commit -m "test: add manual browser service test"
```

---

## 文档更新

### Task 10: 更新 README.md

**文件:**
- Modify: `README.md`

**Step 1: 添加安装说明**

在"安装"部分添加:

```markdown
## 安装

### 前置要求

- **Node.js** >= 18
- **Chromium 浏览器** (通过 npm 自动安装)

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/your-repo/jimeng-api.git
cd jimeng-api

# 2. 安装依赖 (会自动下载 Chromium)
npm install

# 3. 配置环境变量
cp .env.example .env
```

**注意**: 首次安装时会自动下载 Chromium 浏览器 (约 300MB),请确保网络连接正常。
```

**Step 2: 添加浏览器代理服务说明**

在"功能特性"部分添加:

```markdown
- **浏览器代理**: 为 seedance 模型提供 Playwright 浏览器代理,绕过 shark 反爬机制
```

**Step 3: 添加故障排除部分**

```markdown
## 故障排除

### Chromium 下载失败

如果 `npm install` 时 Chromium 下载失败,可以手动安装:

```bash
npx playwright-core install chromium
```

### 浏览器代理服务不可用

如果遇到"浏览器代理服务不可用"错误:

1. 检查 Chromium 是否已安装:
   ```bash
   npx playwright-core install --dry-run chromium
   ```

2. 重新安装 Chromium:
   ```bash
   npx playwright-core install chromium --force
   ```

3. 检查服务器内存是否足够 (建议至少 512MB 可用内存)
```

**Step 4: 提交变更**

```bash
git add README.md
git commit -m "docs: add browser proxy installation and troubleshooting guide"
```

---

## 最终验证

### Task 11: 端到端测试

**Step 1: 启动服务**

```bash
npm run dev
```

Expected: 服务启动成功,浏览器代理服务初始化成功

**Step 2: 测试 seedance 模型生成**

使用 API 客户端或 curl 发送请求:

```bash
curl -X POST http://localhost:3000/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0",
    "prompt": "一只猫在草地上奔跑",
    "image_url": "https://example.com/cat.jpg"
  }'
```

Expected: 视频生成成功,日志显示使用了浏览器代理

**Step 3: 检查日志**

查找日志中的以下信息:
- `[browser] 正在启动 Chromium...`
- `[browser] Chromium 已启动`
- `[browser] 通过浏览器代理请求: POST ...`
- `[browser] bdms SDK 已就绪`

**Step 4: 测试优雅关闭**

```bash
# 按 Ctrl+C
```

Expected: 服务优雅关闭,浏览器会话清理完毕

**Step 5: 提交最终文档**

```bash
git add docs/plans/2025-02-23-playwright-browser-proxy.md
git commit -m "docs: complete browser proxy implementation plan"
```

---

## 实施检查清单

- [ ] Task 1: 安装 playwright-core 依赖
- [ ] Task 2: 创建浏览器配置常量
- [ ] Task 3: 实现 BrowserService 类
- [ ] Task 4: 集成到应用启动流程
- [ ] Task 5: 添加优雅关闭处理
- [ ] Task 6: 修改视频生成控制器
- [ ] Task 7: 导出辅助常量
- [ ] Task 8: 更新导入语句
- [ ] Task 9: 创建手动测试脚本
- [ ] Task 10: 更新 README 文档
- [ ] Task 11: 端到端测试验证

---

**下一步:** 使用 `superpowers:executing-plans` 技能按任务顺序实施此计划,每个任务完成后进行测试和提交。
