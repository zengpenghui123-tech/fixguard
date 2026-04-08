# fixguard — Project Brief

## 痛点
AI 编程助手（Claude Code / Cursor / Copilot）跨会话失忆，不知情地覆盖已修复的 bug。
开发者反复修同一个问题，浪费大量时间。

## 解法
在代码里加 `@fix` 注释标记关键修复 → 自动生成注册表 → git hook 拦截触碰保护区的变更。

## 核心命令
- `fixguard init`   — 在项目里安装 git hook
- `fixguard scan`   — 扫描代码里的 @fix 注释，生成 FIXES.md
- `fixguard check`  — 检查当前 diff 是否触碰了保护区（git hook 自动调用）

## @fix 注释格式
```js
// @fix [tag] "reason — what NOT to do"
function criticalCode() { ... }
```

## 集成目标
1. git pre-commit hook（核心）
2. Claude Code PreToolUse hook（Edit 前自动查保护标记）
3. VS Code 扩展（高亮 + hover 显示原因）
4. npm 发布（`npx fixguard init`）
