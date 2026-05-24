# Tab-Organizer

一个 Chrome Manifest V3 扩展 MVP，用来模拟 ChatGPT Atlas 的标签自动整理体验：读取当前窗口的标签页，根据本地规则或 OpenAI-compatible 模型生成分组，并调用 Chrome 原生 `tabGroups` API 创建标签组。

## 功能

- 支持 Chrome 和 Firefox
- 一键整理当前窗口标签页
- 支持用户输入整理要求
- 默认整理规则：按标题和 URL 的主题分组，保留已有分组，只整理未归类标签，新建分组名使用 emoji + 中文
- 支持“未归类”和“全部重整”两种整理范围
- 可选 OpenAI-compatible 中转站智能分组
- 模型调用失败时会显示错误原因，并自动回退本地规则
- 模型请求默认 12 秒超时，弹窗 18 秒兜底，避免一直停在“正在整理”
- 模型接口权限按 API Base URL 动态申请，不默认请求所有网站访问权限
- API Key 仅保存在本机 `chrome.storage.local`

## Chrome 安装

1. 打开 Chrome：`chrome://extensions`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本文件夹：`Tab-Organizer`
5. 点击工具栏扩展图标，输入整理要求后点击“整理当前窗口标签”

## Firefox 临时安装

Firefox 使用自己的后台脚本 manifest，因此需要先生成 Firefox 版本目录：

```bash
./scripts/build-firefox.sh
```

然后打开 Firefox：

1. 进入 `about:debugging#/runtime/this-firefox`
2. 点击“临时载入附加组件”
3. 选择 `dist/firefox/manifest.json`
4. 点击工具栏扩展图标，开始整理当前窗口标签页

Firefox 需要支持原生标签组和 `tabGroups` WebExtension API。建议使用 Firefox 139 或更新版本。

## 整理范围

- 未归类：保留已有分组，只处理还没有进入标签组的标签页。
- 全部重整：先让当前窗口中可整理的普通网页标签退出旧分组，再按当前规则重新创建分组。

## 使用中转站智能分组

1. 打开扩展弹窗
2. 点击右上角设置按钮
3. 填入中转站的 API Base URL，例如：`https://api.example.com/v1`
4. 填入 API Key 和模型名，例如：`gpt-4o-mini`、`claude-3-5-sonnet`、`deepseek-chat`
5. 勾选“使用模型智能分组”
6. 保存设置后再整理

首次使用某个中转站域名时，Chrome 会弹出访问该域名的权限确认。这是为了避免扩展默认请求所有网站访问权限。

如果没有勾选“使用模型智能分组”，扩展只会使用本地规则。本地规则不理解长句语义，主要按域名和明确关键词整理。

如果使用 `deepseek-reasoner` 这类推理模型，中转站响应可能偏慢。标签分组不需要强推理模型，优先建议使用响应更快的聊天模型，例如 `deepseek-chat` 或中转站提供的轻量模型。

接口要求：中转站需要兼容 OpenAI Chat Completions：`POST {API Base URL}/chat/completions`。

## 默认整理规则

```text
依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料
```

后台执行时会优先保留已有标签组，只处理未归类标签；如果未归类标签适合现有组，会加入现有组，否则新建 emoji + 中文组名。

注意：浏览器扩展无法真正保护前端环境中的 API Key。如果要发布给他人使用，建议改成自建后端代理，由后端保存密钥并调用模型接口。

## 与 Atlas 的差异

Atlas 的 Auto-organize 可以结合 ChatGPT 的浏览器记忆和用户指令。Chrome 扩展无法访问 Atlas 的浏览器记忆，所以这里的等价实现使用当前窗口标签标题、URL、域名和用户输入来分组。
