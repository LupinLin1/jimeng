import { chromium, Browser, BrowserContext } from 'playwright-core';
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
 * 每个 sessionId 对应一个隔离的 BrowserContext（共享 Cookie/bdms 状态）
 * Page 不再持久化，每次请求临时创建，用完销毁，支持同 session 并发
 */
interface BrowserSession {
  context: BrowserContext;
  lastUsed: number;
  idleTimer: NodeJS.Timeout;
  /** 创建锁：防止同一 sessionId 并发初始化时重复创建 context */
  ready: Promise<void>;
}

/**
 * 浏览器代理服务
 *
 * 负责:
 * - 启动和管理 Chromium 浏览器实例
 * - 为每个 sessionId 创建隔离的浏览器上下文（复用，持久化 bdms/Cookie）
 * - 每次请求创建独立 Page，执行完后销毁（支持同 sessionId 并发）
 * - 管理会话生命周期 (10分钟空闲超时)
 */
class BrowserService {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSession> = new Map();
  private available: boolean = false;
  /** 全局创建锁：防止 getSession 并发时对同一 sessionId 重复初始化 */
  private creatingSession: Map<string, Promise<BrowserSession>> = new Map();

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
   * 创建新的 BrowserContext（内部方法）
   * 负责注入 Cookie、配置资源拦截、等待 bdms SDK
   */
  private async createContext(
    sessionId: string,
    webId: string,
    userId: string
  ): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();

    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
    });

    // 注入 Cookie
    await context.addCookies([
      { name: '_tea_web_id', value: String(webId), domain: '.jianying.com', path: '/' },
      { name: 'is_staff_user', value: 'false', domain: '.jianying.com', path: '/' },
      { name: 'store-region', value: 'cn-gd', domain: '.jianying.com', path: '/' },
      { name: 'uid_tt', value: String(userId), domain: '.jianying.com', path: '/' },
      { name: 'sid_tt', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid', value: sessionId, domain: '.jianying.com', path: '/' },
      { name: 'sessionid_ss', value: sessionId, domain: '.jianying.com', path: '/' },
    ]);

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

    // 用临时 page 导航到即梦首页，等待 bdms SDK 加载完成后销毁
    const initPage = await context.newPage();
    logger.info(`[browser] 正在导航到 jimeng.jianying.com (session: ${sessionId.substring(0, 8)}...)`);
    await initPage.goto('https://jimeng.jianying.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    try {
      await initPage.waitForFunction(
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

    // 初始化页面用完即销毁
    await initPage.close();

    return context;
  }

  /**
   * 获取或创建浏览器会话（带创建锁，防并发重复初始化）
   */
  async getSession(sessionId: string, webId: string, userId: string): Promise<BrowserSession> {
    // 已有会话直接返回
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      clearTimeout(existing.idleTimer);
      existing.idleTimer = setTimeout(() => this.closeSession(sessionId), SESSION_IDLE_TIMEOUT);
      return existing;
    }

    // 若已有同 sessionId 的创建任务在进行，等它完成
    const creating = this.creatingSession.get(sessionId);
    if (creating) {
      logger.debug(`[browser] 等待已有创建任务完成 (session: ${sessionId.substring(0, 8)}...)`);
      await creating;
      return this.sessions.get(sessionId)!;
    }

    // 发起创建，并注册到 creatingSession 防止并发重入
    logger.info(`[browser] 创建新会话: ${sessionId.substring(0, 8)}...`);
    const createPromise = (async (): Promise<BrowserSession> => {
      try {
        const context = await this.createContext(sessionId, webId, userId);
        const session: BrowserSession = {
          context,
          lastUsed: Date.now(),
          idleTimer: setTimeout(() => this.closeSession(sessionId), SESSION_IDLE_TIMEOUT),
          ready: Promise.resolve(),
        };
        this.sessions.set(sessionId, session);
        logger.info(`[browser] 会话已创建 (session: ${sessionId.substring(0, 8)}...)`);
        return session;
      } finally {
        this.creatingSession.delete(sessionId);
      }
    })();

    this.creatingSession.set(sessionId, createPromise);
    return createPromise;
  }

  /**
   * 在浏览器中执行 HTTP 请求
   * 每次调用创建独立 Page，执行完后销毁，支持同 sessionId 并发
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

    // 每次请求独立 page，执行完即销毁，支持并发
    // 必须先导航到目标域名，否则 about:blank 页面无法发出跨域 fetch
    const page = await session.context.newPage();
    try {
      const targetOrigin = new URL(url).origin;
      await page.goto(targetOrigin, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const result = await page.evaluate(
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
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * 关闭指定会话
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    clearTimeout(session.idleTimer);

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

    const sessionCount = this.sessions.size;
    logger.info(`[browser] 关闭 ${sessionCount} 个活动会话...`);
    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId);
    }

    if (this.browser) {
      try {
        logger.info('[browser] 正在关闭 Chromium 实例...');
        await this.browser.close();
        this.browser = null;
        logger.info('[browser] Chromium 已关闭');
      } catch (error: any) {
        logger.warn(`[browser] 关闭 Chromium 失败: ${error.message}`);
        this.browser = null;
      }
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
