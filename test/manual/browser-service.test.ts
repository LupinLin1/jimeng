/**
 * 浏览器服务手动测试
 *
 * 运行: npm run test:browser
 */

import browserService from '../../src/lib/browser-service.ts';

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
