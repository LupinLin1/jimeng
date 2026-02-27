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
];

// bdms SDK 加载检测超时配置
export const BDMS_CHECK_CONFIG = {
  // 最大等待时间
  timeout: BDMS_READY_TIMEOUT,
  // 轮询间隔 (毫秒)
  interval: 500,
};
