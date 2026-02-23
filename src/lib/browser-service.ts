import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import logger from './logger.ts';
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
    if (body) {
      logger.info(`[browser] 请求体: ${body.substring(0, 1000)}...`);
    }

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
    logger.info('[browser] 正在关闭浏览器服务...');

    // 关闭所有会话
    const sessionCount = this.sessions.size;
    logger.info(`[browser] 关闭 ${sessionCount} 个活动会话...`);
    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId);
    }

    // 关闭浏览器
    if (this.browser) {
      try {
        logger.info('[browser] 正在关闭 Chromium 实例...');
        const closeStart = Date.now();

        // 直接调用 close，不使用超时
        // 如果它挂起，那是 Playwright 的问题
        await this.browser.close();

        const closeDuration = Date.now() - closeStart;
        this.browser = null;
        logger.info(`[browser] Chromium 已关闭 (耗时: ${closeDuration}ms)`);
      } catch (error: any) {
        logger.warn(`[browser] 关闭 Chromium 失败: ${error.message}`);
        // 即使失败也清理引用
        this.browser = null;
      }
      logger.info('[browser] 浏览器关闭操作完成');
    } else {
      logger.warn('[browser] 浏览器实例为空，跳过关闭');
    }

    this.available = false;
    logger.info('[browser] 浏览器服务已关闭');
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
