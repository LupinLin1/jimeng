# 即梦API真实请求分析报告

## 🎯 成功捕获真实请求！

通过Chrome DevTools成功捕获到即梦官网的真实请求。

---

## 📊 关键发现

### 1. User-Agent版本不匹配 ⚠️

**官网使用**:
```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
```

**代码中使用**:
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
```

**问题**:
- Chrome版本：官网145 vs 代码131（差异14个版本）
- 操作系统：官网macOS vs 代码Windows
- 平台版本：官网10_15_7 vs 代码10.0

### 2. da_version版本不匹配 ⚠️

**官网使用**: `3.3.9`
**代码中使用**: `3.3.8`

这个差异可能导致请求被拒绝！

### 3. 关键参数对比

| 参数 | 官网值 | 代码值 | 状态 |
|------|--------|--------|------|
| `web_version` | `7.5.0` | `7.5.0` | ✅ 匹配 |
| `da_version` | `3.3.9` | `3.3.8` | ❌ **不匹配** |
| `aigc_features` | `app_lip_sync` | `app_lip_sync` | ✅ 匹配 |
| `aid` | `513695` | `513695` | ✅ 匹配 |
| `device_platform` | `web` | `web` | ✅ 匹配 |
| `region` | `CN` | `CN` | ✅ 匹配 |

### 4. 请求头差异

**官网包含但代码缺失的请求头**:
- `sec-ch-ua-platform: "macOS"`
- `sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"`

---

## 🔧 需要修复的问题

### 问题1: da_version版本错误

**文件**: `src/api/consts/dreamina.ts`

**当前值**:
```typescript
export const DA_VERSION = "3.3.8";
export const DRAFT_VERSION = "3.3.8";
export const DRAFT_VERSION_OMNI = "3.3.9";
```

**应改为**:
```typescript
export const DA_VERSION = "3.3.9";
export const DRAFT_VERSION = "3.3.9";  // 首尾帧模式也使用3.3.9
export const DRAFT_VERSION_OMNI = "3.3.9";
```

### 问题2: User-Agent版本过旧

**文件**: `src/api/controllers/core.ts`

**当前值**:
```typescript
"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
"Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
```

**应改为**:
```typescript
"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
"Sec-Ch-Ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
"Sec-Ch-Ua-Platform": '"macOS"',
```

### 问题3: 缺少Sec-Ch-Ua-Platform

已在之前的优化中添加，但版本不匹配。

---

## 🎯 修复优先级

### 高优先级（立即修复）
1. ✅ **da_version**: 3.3.8 → 3.3.9
2. ✅ **User-Agent**: Chrome 131 → 145

### 中优先级（建议修复）
3. ✅ **Sec-Ch-Ua版本**: 同步更新
4. ✅ **Sec-Ch-Ua-Platform**: macOS

### 低优先级（可选）
5. 操作系统指纹（macOS vs Windows）
6. Web ID动态获取

---

## 📝 修复方案

### 修复1: 更新da_version

```typescript
// src/api/consts/dreamina.ts
export const DA_VERSION = "3.3.9";
export const DRAFT_VERSION = "3.3.9";
export const DRAFT_VERSION_OMNI = "3.3.9";
```

### 修复2: 更新User-Agent和Sec-Ch-Ua

```typescript
// src/api/controllers/core.ts
const FAKE_HEADERS = {
  // ... 其他headers
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Sec-Ch-Ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Ch-Ua-Platform-Version": '"10.15.7"',
  // ... 其他headers
};
```

---

## ⚠️ 重要发现

### da_version差异可能是主要问题！

从错误信息看：
- 之前token（被封账号）返回错误码1019 "shark not pass"
- 新token在官网可以正常使用（虽然积分不足）
- **但新token使用3.3.9版本，而代码用的是3.3.8**

这很可能是导致请求被拒绝的原因！

---

## ✅ 验证计划

修复后需要验证：
1. 更新da_version到3.3.9
2. 更新User-Agent到Chrome 145
3. 使用新token测试API调用
4. 对比官网和代码的请求

---

## 📌 总结

**核心问题**: 版本号不匹配
- da_version: 3.3.8 vs 3.3.9 ❌
- Chrome: 131 vs 145 ❌

**这两个版本差异很可能是导致请求失败的主要原因！**

**建议**: 立即更新这两个参数后重新测试。
