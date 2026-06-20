---
name: zzap
description: >
  智能提交与版本管理：分析变更、拆分提交、自动升级版本、维护 CHANGELOG、执行发布流程。
  Use when 用户要求提交、commit、版本发布、冲！，或提到 "zzap" / "提交" / "发布" / "release"。
---

# zzap — 智能提交与版本管理

## 项目配置

### 版本文件

| 文件 | 字段路径 | 版本格式 |
|------|----------|----------|
| package.json | .version | bare |
| apps/desktop/package.json | .version | bare |
| apps/desktop/src-tauri/Cargo.toml | [package].version | bare |
| apps/desktop/src-tauri/tauri.conf.json | .version | bare |

### 功能开关

| 功能 | 状态 |
|------|------|
| CHANGELOG | 启用 |
| 版本发布资料整理 | 启用 |

---

## 版本规则

- 三段式 `x.y.z`，各段为纯数字，无上限
- **普通提交**：z+1（`0.1.0` → `0.1.1`）
- **版本发布-普通**：y+1, z归零（`0.5.30` → `0.6.0`）
- **版本发布-超大规模**：x+1, y.z归零（`1.33.2` → `2.0.0`）
- 版本文件含 `v` 前缀时，写回保留前缀；CHANGELOG/PR/TAG 中取纯数字部分
- 版本号提取正则：`(\d+\.\d+\.\d+)`

---

## 模式判断

| 信号 | 模式 |
|------|------|
| 用户调用 `/zzap` 无额外关键词 | 普通提交 |
| 用户消息含"版本发布"或"release" | 版本发布提交 |

---

## 普通提交流程

### 1. 分析暂存变更

运行 `git diff --cached --stat` 和 `git diff --cached`，分析变更内容和范围。

### 2. 判断是否拆分

变更跨多个不相关 scope 时拆分为多组。同 scope 或强关联变更保持一组。

### 3. 执行提交

对每组变更执行 `/zap` 技能完成提交。zzap **不自创提交流程**，全部委托 `/zap`。

如需拆分：先 `git reset HEAD` 取消暂存，按组逐个 `git add` 后调用 `/zap`。

收集每次提交的：hash、时间戳（`git log -1 --format=%ai <hash>`）、type、description。

### 4. 升级版本

读取所有版本文件，提取当前版本号，z+1 后写回。写回时保留文件原始格式（`v` 前缀 / 引号 / 缩进）。

### 5. 维护 CHANGELOG

**仅 CHANGELOG 功能启用时执行。**

追加条目到 CHANGELOG.html。每个 commit 写一条记录。

条目格式：`[MM-DDTHH:MM] <emoji> <产品/项目/功能维度的描述>`

Emoji 映射：

| 提交 type | Emoji | 含义 |
|-----------|-------|------|
| `fix` | 🐛 | 问题修复 |
| `feat` | 🎁 | feature 新增/优化 |
| 其他 | 📄 | 非🐛非🎁 |

更新当前月份 `<details>` 块的 `<summary>`：

- 有版本发布：`YYYY-MM: 🎉V<ver> - <desc>`（多版本融合描述）
- 无版本发布：`YYYY-MM: <产品维度代表性总结>`

**summary 总结提示词**：从本月变更中提炼最核心的产品能力变化，用一句话概括用户可感知的升级，避免代码细节。

### 6. 提交版本 + CHANGELOG 变更

```
git add <版本文件> CHANGELOG.html
git commit -m "chore(<scope>): bump version to X.Y.Z"
```

### 7. 输出摘要

```
✅ 提交完成
提交: <hash1>, <hash2>, ...
版本: X.Y.Z → X.Y.Z+1
CHANGELOG: ✅ 已更新（如启用）
📤 待推送: <N> commits ahead of origin
```

---

## 版本发布流程

**仅在用户明确表示"版本发布"时触发。版本发布资料整理功能启用时才执行完整发布流程。**

### 1. 完成待处理提交

如有暂存变更，先执行普通提交流程。

### 2. 询问发布类型

使用 AskUserQuestion：

```json
{
  "question": "版本发布类型？",
  "header": "发布",
  "options": [
    {"label": "普通版本", "description": "y+1，z归零（例如 0.5.30 → 0.6.0）"},
    {"label": "超大规模版本", "description": "x+1，y.z归零（例如 1.33.2 → 2.0.0）"}
  ],
  "multiSelect": false
}
```

### 3. 计算并更新版本

读取当前版本 → 按发布类型计算新版本 → 写入所有版本文件。

### 4. 维护 CHANGELOG

**版本发布资料整理功能启用时，CHANGELOG 自动为必做项。**

添加版本发布条目：`🎉V<version> - [MM-DDTHH:MM] <emoji> <产品维度描述>`

更新 `<summary>` 为版本发布格式。

### 5. 提交发布变更

```
git add <版本文件> CHANGELOG.html
git commit -m "release(<scope>): V<version> - <description>"
```

### 6. 创建 PR

收集 CHANGELOG 中自上次版本发布至今的所有条目，以产品维度重述。

```bash
gh pr create --title "🎉V<version> - <产品维度标题>" --body "<bullet list>"
```

平台判断：`git remote get-url origin` 含 `github.com` 用 `gh`，含 `gitlab.com` 用 `glab`。

### 7. 合并 PR + 清理

```bash
gh pr merge <pr-number>
git push origin --delete <branch>    # 删除远端分支
git branch -d <branch>               # 删除本地分支（已 merge 后自动在主分支）
```

### 8. 打 TAG

```bash
git tag V<version>-<kebab-case功能简述>
```

### 9. 输出发布摘要

```
✅ 版本发布完成
版本: X.Y.Z → X+1.0.0
PR: #<number> 已合并
TAG: V<version>-<description>
📤 待推送: <N> commits + <N> tags ahead of origin
```

---

## CHANGELOG.html 完整格式

按月份自然顺序（旧→新），每月一个 `<details>` 块，便于追加维护。

```html
<details>
<summary>2026-05: 代码质量优化与性能提升</summary>

[05-15T14:30] 🐛 修复数据导出编码错误
[05-20T10:00] 📄 重构项目目录结构
[05-28T16:00] 🎁 新增仪表盘自定义布局功能

</details>

<details>
<summary>2026-06: 🎉V1.2.0 - 用户管理系统升级</summary>

[06-05T09:00] 🐛 修复登录页面 Safari 兼容问题
[06-07T10:15] 📄 优化项目构建配置
🎉V1.2.0 - [06-07T14:30] 🎁 用户管理系统重大升级，新增导出与批量操作

</details>
```

**写入策略**：始终完整重建文件，不增量追加。

**时间戳来源**：`git log -1 --format=%ai <hash>` 取 commit author date。

**描述约束**：以产品/项目/功能维度总结，**DO NOT** 出现代码/文档细节改动描述。

---

## 版本号在 CHANGELOG/PR 中的处理

- 版本文件含 `v` 前缀（如 `v1.0.0`）→ 用正则 `(\d+\.\d+\.\d+)` 提取纯数字
- CHANGELOG/PR 标题/TAG 统一使用 `V1.2.3` 格式（大写 V + 纯数字）
- **DO NOT** 产生 `Vv1.0.0` 这样的双重前缀
- 写回版本文件时保留原始格式
