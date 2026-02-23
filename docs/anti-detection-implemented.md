# 即梦API防风控优化实施总结

## ✅ 已实施的优化措施

### 1. 增强请求头特征 ✅

**文件**: `src/api/controllers/core.ts`

**优化内容**:
- 更新Chrome版本到131（更现代）
- 添加完整的Sec-Ch-Ua特征头：
  - `Sec-Ch-Ua-Platform-Version`: Windows 15.0.0
  - `Sec-Ch-Ua-Model`: 空字符串
  - `Sec-Ch-Ua-Arch`: x86
  - `Sec-Ch-Ua-Bitness`: 64
  - `Sec-Ch-Ua-Full-Version`: 131.0.6778.86
- 添加 `Sec-Fetch-User: ?1`
- 添加 `Upgrade-Insecure-Requests: 1`
- 更新 Accept-Language 为更完整的格式

**代码位置**: `core.ts:44-68`

### 2. 请求延迟控制 ✅

**文件**: `src/api/controllers/core.ts`, `src/api/consts/common.ts`

**优化内容**:
- 新增 `ANTI_DETECTION_CONFIG` 配置项
- 实现 `enforceRequestDelay()` 函数
- 最小请求间隔: 2秒
- 最大请求间隔: 5秒
- 随机延迟模拟真实用户行为

**配置项**:
```typescript
export const ANTI_DETECTION_CONFIG = {
  MIN_REQUEST_DELAY: 2000,   // 2秒
  MAX_REQUEST_DELAY: 5000,   // 5秒
  ENABLE_RANDOM_DELAY: true,
};
```

**代码位置**:
- `common.ts:38-43` - 配置定义
- `core.ts:74-100` - 延迟函数实现
- `core.ts:390` - 集成到请求流程

### 3. JSON字段顺序保持 ✅

**文件**: `src/lib/util.ts`

**优化内容**:
- 新增 `stableStringify()` 函数
- 确保JSON序列化时字段顺序一致
- 递归处理嵌套对象和数组

**代码位置**: `util.ts:283-309`

## 📊 优化效果预期

### 减少风控触发概率的因素

1. **更真实的浏览器指纹**
   - 现代化的Chrome特征头
   - 完整的Sec-Ch-Ua信息

2. **人类化的请求行为**
   - 随机延迟避免机器特征
   - 合理的请求间隔

3. **一致的请求格式**
   - 稳定的JSON字段顺序
   - 避免异常的请求体结构

## ⚠️ 重要说明

### 优化局限性

这些技术优化**无法解决账号层面的风控问题**：

1. **账号已被标记**
   - 如果账号之前有违规记录
   - 账号在官网也被禁止使用
   - 技术手段无法绕过账号级别的封禁

2. **验证失败的原因**
   - 错误码1019 "shark not pass"
   - 这是字节跳动风控系统的拦截
   - 可能的原因：
     * 账号历史违规
     * Token被标记
     * IP地址异常
     * 请求频率过高

## 🔧 使用建议

### 1. 配置延迟（已启用）

默认配置已启用随机延迟，无需额外配置。

如需调整：
```typescript
// src/api/consts/common.ts
export const ANTI_DETECTION_CONFIG = {
  MIN_REQUEST_DELAY: 3000,  // 增加到3秒
  MAX_REQUEST_DELAY: 8000,  // 增加到8秒
  ENABLE_RANDOM_DELAY: true,
};
```

### 2. 使用代理

如果需要更换IP，在token前添加代理：

```bash
# 格式
http://proxy-server:port@region-token

# 示例
http://proxy.example.com:8080@cn-your_token_here
```

### 3. 控制请求频率

- 避免短时间内大量请求
- 单个账号建议每天不超过100次请求
- 使用多个账号分散请求

### 4. 账号管理

- ✅ 使用新的、无违规记录的账号
- ✅ 遵守平台使用规范
- ✅ 定期更换token
- ❌ 不要使用已被封禁的账号

## 🧪 测试建议

### 测试步骤

1. **使用新token测试**
   ```bash
   curl -X POST http://localhost:3000/v1/videos/generations \
     -H "Authorization: Bearer 你的新token" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "jimeng-video-seedance-2.0",
       "prompt": "测试提示词",
       "duration": 5
     }'
   ```

2. **观察日志输出**
   - 查看延迟日志: `防风控延迟: X.XX秒`
   - 确认请求头正确
   - 检查响应状态

3. **验证官网状态**
   - 登录 https://jimeng.jianying.com
   - 尝试手动生成视频
   - 确认账号是否正常

### 预期结果

**如果账号正常**:
- ✅ 延迟日志正常输出
- ✅ 请求成功返回视频URL
- ✅ 官网也能正常使用

**如果账号被封禁**:
- ❌ 返回错误码1019 "shark not pass"
- ❌ 官网显示违规提示
- 💡 需要更换账号

## 📝 后续优化方向

如果技术优化后仍有问题，可以考虑：

1. **升级HTTP库**
   - 使用支持TLS指纹的库
   - 例如: `undici`, `got`

2. **更复杂的指纹模拟**
   - WebRTC指纹
   - Canvas指纹
   - 音频指纹

3. **行为模拟**
   - 随机鼠标移动（如果有前端）
   - 随机页面停留时间
   - 模拟真实用户操作流程

4. **分布式请求**
   - 使用多个代理IP
   - 多个账号轮换
   - 请求队列管理

## 📞 获取帮助

如果仍然遇到问题：

1. **检查日志**
   - 查看完整的错误信息
   - 确认请求参数是否正确

2. **验证账号**
   - 在官网测试账号状态
   - 确认积分是否充足

3. **联系支持**
   - 查看项目文档
   - 提交Issue到GitHub

---

**更新时间**: 2025-02-21
**版本**: 1.0.0
