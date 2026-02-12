# API配置管理器 (API Config Manager)

用于 SillyTavern 的多配置 API 管理扩展，支持快速切换、分组管理、模型联动与移动端适配。

## 功能特性

- 多配置管理：保存并管理多个 API 配置（Custom / Google AI Studio）。
- 一键应用：应用配置后自动触发连接，并尝试设置首选模型。
- 双入口：
  - API 连接页卡片入口（打开配置面板）。
  - 左下角菜单入口（`API配置管理器`）。
- 现代配置面板：
  - 左侧配置列表，右侧编辑区。
  - 支持搜索、编辑、删除、应用。
  - 支持按组 / 按使用习惯（最近 7 天）/ 按名称排序。
- 自动分组：
  - 优先识别名称前缀（如 `vendor-xx`、`vendor xx`）。
  - 其次根据 URL 域名自动识别。
  - 单条配置不强制显示成组标题。
- 经典配置方式并存：
  - 在 API 连接页入口下方保留经典抽屉式配置。
  - 经典方式同样支持 `Custom` 与 `Google AI Studio`。
- 移动端适配：
  - 移动端采用列表/编辑切屏逻辑，减少布局溢出。
  - 列表项支持更大卡片与项内“应用配置”按钮。
- 隐私与安全：
  - 密钥通过 SillyTavern 的 secrets 机制读写。
  - 配置存储在本地 `extension_settings`。

## 安装

### 通过 Git URL 安装（推荐）

1. 打开 SillyTavern。
2. 进入扩展安装页面（Install Extension / 安装扩展）。
3. 输入仓库地址：

```text
https://github.com/Lorenzzz-Elio/api-config-manager.git
```

4. 安装后重启 SillyTavern，并启用扩展。

### 手动安装

1. 下载本仓库代码。
2. 放到：

```text
SillyTavern/public/scripts/extensions/api-config-manager/
```

3. 重启 SillyTavern。

## 使用指南

## 入口

1. API 连接页中的 `API配置管理器` 卡片，点击“打开配置面板”。
2. 左下角菜单中点击 `API配置管理器`。

## 配置面板

1. 左侧选择配置或点击“添加”。
2. 右侧填写/修改：来源、URL/反代、密钥、模型、分组。
3. 点击“保存配置”或“更新配置”。
4. 选中配置后可“应用配置”或删除。

## 经典配置方式（API连接页下方）

1. 展开“经典配置方式”。
2. 选择接入类型（Custom / Google AI Studio）。
3. 填写对应字段并保存。
4. 可在经典列表中直接应用、编辑、删除。

## 排序与分组说明

- 排序按钮会循环切换：按组排列 -> 按习惯排列 -> 按名称排列。
- “按习惯排列”依据最近 7 天使用记录。
- 分组优先读取手动分组；为空时自动识别。

## 支持的接入类型

- Custom（OpenAI 兼容）
- Google AI Studio（MakerSuite）

## 数据与隐私

- 配置保存在 `extension_settings.api-config-manager`。
- 使用历史仅用于本地排序（最近 7 天窗口）。
- 密钥通过 SillyTavern secrets 系统管理。

详细隐私说明：`PRIVACY.md`

## 文件结构

```text
api-config-manager/
├── manifest.json
├── index.js
├── style.css
├── settings.html
├── README.md
└── PRIVACY.md
```

## 版本信息

- 当前版本：`1.3.1`
- 许可证：MIT（见 `LICENSE`）
