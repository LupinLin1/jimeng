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
 * 每个 sessionId 对应一个隔离的 BrowserContext（共享 Cookie/bdms 状态）
 * page 持久化复用，已加载 bdms SDK，支持在页面上下文中执行 fetch（携带风控 token）
 * 并发请求通过 fetchLock 串行化，避免多个 page.evaluate 并发冲突
 */
interface BrowserSession {
  context: BrowserContext;
  /** 持久化页面：已导航至即梦首页，bdms SDK 已就绪，用于执行 fetch */
  page: Page;
  lastUsed: number;
  idleTimer: NodeJS.Timeout;
  /** 创建锁：防止同一 sessionId 并发初始化时重复创建 context */
  ready: Promise<void>;
  /** fetch 串行锁：确保同一 page 上的 evaluate 调用不并发 */
  fetchLock: Promise<void>;
}

/**
 * 浏览器代理服务
 *
 * 负责:
 * - 启动和管理 Chromium 浏览器实例
 * - 为每个 sessionId 创建隔离的浏览器上下文（复用，持久化 bdms/Cookie）
 * - 每次 fetch 请求在持久化页面上通过 page.evaluate 执行（bdms SDK 自动注入风控 token）
 * - 同一 session 并发请求通过 fetchLock 串行化（避免同一页面并发 evaluate 冲突）
 * - 管理会话生命周期 (10分钟空闲超时)
 */
class BrowserService {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSession> = new Map();
  private available: boolean = false;
  /** 全局创建锁：防止 getSession 并发时对同一 sessionId 重复初始化 */
  private creatingSession: Map<string, Promise<BrowserSession>> = new Map();
  private newPageFailureCount: number = 0;  // 记录连续失败次数
  private readonly MAX_FAILURES_BEFORE_RESET = 3;  // 失败次数阈值
  /** 全局重置锁：防止多个请求同时重置浏览器 */
  private resetPromise: Promise<void> | null = null;

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
   * 如果正在重置中，等待重置完成
   */
  private async ensureBrowser(): Promise<Browser> {
    // 如果正在重置，等待重置完成
    if (this.resetPromise) {
      logger.debug('[browser] 浏览器正在重置中，等待完成...');
      await this.resetPromise;
    }

    // 检查浏览器连接状态，若已断开（进程崩溃）则触发重置
    if (this.browser && !this.browser.isConnected()) {
      logger.warn('[browser] 检测到浏览器进程已断开，触发重置...');
      await this.resetBrowser();
    }

    if (this.browser) return this.browser;

    if (!this.available) {
      throw new Error('浏览器服务不可用');
    }

    await this.initialize();
    return this.browser!;
  }

  /**
   * 创建新的 BrowserContext 和持久化页面（内部方法）
   * 负责注入 Cookie、配置资源拦截、等待 bdms SDK、保留页面
   */
  private async createContext(
    sessionId: string,
    webId: string,
    userId: string
  ): Promise<{ context: BrowserContext; page: Page }> {
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

    // 导航到即梦首页，等待 bdms SDK 加载完成
    // 此页面持久化保留，后续 fetch 请求都在此页面执行（bdms SDK 自动注入风控 token）
    let page: Page;
    try {
      // 添加超时配置，防止 newPage() 无限期挂起
      page = await Promise.race([
        context.newPage(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('创建页面超时 (10秒)')), 10000)
        ),
      ]);
      logger.info(`[browser] 页面创建成功 (session: ${sessionId.substring(0, 8)}...)`);
      // 页面创建成功，重置失败计数
      this.newPageFailureCount = 0;
    } catch (error: any) {
      logger.error(`[browser] 创建页面失败: ${error.message}`);

      // 增加失败计数
      this.newPageFailureCount++;
      logger.warn(`[browser] newPage 失败计数: ${this.newPageFailureCount}/${this.MAX_FAILURES_BEFORE_RESET}`);

      // 如果是浏览器/上下文已关闭错误（竞态条件），立即重置浏览器实例
      const isBrowserClosed = error.message?.includes('Target page, context or browser has been closed');
      if (isBrowserClosed || this.newPageFailureCount >= this.MAX_FAILURES_BEFORE_RESET) {
        if (isBrowserClosed) {
          logger.error('[browser] 检测到浏览器上下文已关闭（竞态条件），立即重置浏览器实例');
        } else {
          logger.error(`[browser] 连续失败 ${this.newPageFailureCount} 次，重置浏览器实例`);
        }
        await this.resetBrowser();
      }

      // 清理 context 并抛出错误，让上层重试
      try {
        await context.close();
      } catch (closeError) {
        logger.warn(`[browser] 关闭 context 失败: ${closeError.message}`);
      }
      throw new Error(`浏览器页面创建失败: ${error.message}`);
    }

    logger.info(`[browser] 正在导航到 jimeng.jianying.com (session: ${sessionId.substring(0, 8)}...)`);
    try {
      // 使用 domcontentloaded 等待页面 JS 执行（bdms SDK 需要 JS 运行才能注入 fetch 拦截）
      // 资源拦截规则已放行 jianying.com 域名的脚本，DOMContentLoaded 应能正常触发
      await page.goto('https://jimeng.jianying.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (e: any) {
      // 即使 goto 超时，页面 JS 可能已经执行，继续尝试
      logger.warn(`[browser] 页面导航超时，继续尝试: ${e.message}`);
    }

    try {
      await page.waitForFunction(
        () => {
          return (
            (window as any).bdms?.init ||
            (window as any).byted_acrawler
          );
        },
        { timeout: BDMS_READY_TIMEOUT }
      );
      logger.info('[browser] bdms SDK 已就绪');
    } catch {
      logger.warn('[browser] bdms SDK 等待超时,继续尝试...');
    }

    return { context, page };
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
        const { context, page } = await this.createContext(sessionId, webId, userId);
        const session: BrowserSession = {
          context,
          page,
          lastUsed: Date.now(),
          idleTimer: setTimeout(() => this.closeSession(sessionId), SESSION_IDLE_TIMEOUT),
          ready: Promise.resolve(),
          fetchLock: Promise.resolve(),
        };
        this.sessions.set(sessionId, session);
        logger.info(`[browser] 会话已创建 (session: ${sessionId.substring(0, 8)}...)`);
        return session;
      } catch (error: any) {
        logger.error(`[browser] 创建会话失败 (session: ${sessionId.substring(0, 8)}...): ${error.message}`);
        // 确保失败时从 creatingSession 中移除，允许重试
        throw error;
      } finally {
        this.creatingSession.delete(sessionId);
      }
    })();

    this.creatingSession.set(sessionId, createPromise);
    return createPromise;
  }

  /**
   * 在浏览器中执行 HTTP 请求
   * 在持久化页面的 JS 上下文中执行 fetch，bdms SDK 自动注入风控 token
   * 同一 session 的并发请求通过 fetchLock 串行化
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

    // 串行化：等待上一个 fetch 完成，再执行本次
    let releaseLock!: () => void;
    const prevLock = session.fetchLock;
    session.fetchLock = new Promise<void>((resolve) => { releaseLock = resolve; });

    try {
      await prevLock;

      // 在持久化页面的 JS 上下文中执行 fetch
      // bdms/acrawler SDK 已在页面中运行，会自动注入风控 headers/token
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
    } finally {
      releaseLock();
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
      await session.page.close();
    } catch {
      // ignore
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
   * 重置浏览器实例（用于恢复异常状态）
   * 使用重置锁防止并发重置
   */
  private async resetBrowser(): Promise<void> {
    // 如果已经在重置中，等待完成
    if (this.resetPromise) {
      logger.warn('[browser] 浏览器正在重置中，等待现有重置完成...');
      return this.resetPromise;
    }

    // 创建新的重置任务
    this.resetPromise = (async () => {
      logger.warn('[browser] 开始重置浏览器实例...');

      try {
        // 关闭所有会话
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
          await this.closeSession(sessionId);
        }

        // 关闭浏览器实例
        if (this.browser) {
          try {
            await this.browser.close();
            logger.info('[browser] 旧浏览器实例已关闭');
          } catch (error: any) {
            logger.warn(`[browser] 关闭旧浏览器实例失败: ${error.message}`);
          }
          this.browser = null;
        }

        // 等待一下让资源释放
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 重新初始化浏览器
        try {
          await this.initialize();
          logger.info('[browser] 浏览器实例已重置');
        } catch (error: any) {
          logger.error(`[browser] 重置浏览器失败: ${error.message}`);
          this.available = false;
          throw error;
        }

        // 重置失败计数
        this.newPageFailureCount = 0;
      } finally {
        // 清除重置锁
        this.resetPromise = null;
      }
    })();

    return this.resetPromise;
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
