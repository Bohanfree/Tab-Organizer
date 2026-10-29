const GROUP_COLORS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange", "pink", "grey"];
const MODEL_TIMEOUT_MS = 12000;
const TAB_GROUP_ID_NONE = -1;
const extensionApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";
const supportsNativeTabGroups = Boolean(
  extensionApi?.tabs?.group &&
  extensionApi?.tabGroups?.query &&
  extensionApi?.tabGroups?.update
);
const DEFAULT_INSTRUCTIONS = `依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料`;

const runningWindows = new Set();
const previewStorage = extensionApi.storage.session || extensionApi.storage.local;

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["ORGANIZE_TABS", "PREVIEW_TABS", "APPLY_PREVIEW"].includes(message?.type)) {
    return false;
  }

  const responsePromise = handleOperation(message)
    .then((result) => ({ ok: true, ...result }))
    .catch((error) => ({ ok: false, error: error.message }));

  if (usesPromiseApi) {
    return responsePromise;
  }

  responsePromise.then(sendResponse);

  return true;
});

async function handleOperation(message) {
  const options = message.payload || {};
  if (!Number.isInteger(options.windowId)) {
    throw new Error("请重新打开弹窗以读取当前窗口");
  }
  const windowId = options.windowId;
  if (runningWindows.has(windowId)) throw new Error("当前窗口正在整理，请稍后再试");
  runningWindows.add(windowId);
  try {
    const response = await organizeTabs({
      ...options,
      previewOnly: message.type === "PREVIEW_TABS",
      applyPreview: message.type === "APPLY_PREVIEW"
    });
    if (!response.preview) {
      await extensionApi.storage.local.set({ [`lastResult:${windowId}`]: { ...response, savedAt: Date.now() } });
    }
    return response;
  } finally {
    runningWindows.delete(windowId);
  }
}

function tabFingerprint(tabs) {
  return JSON.stringify(tabs.map(({ id, index, url, title, pinned, groupId }) =>
    [id, index, url, title, Boolean(pinned), groupId ?? TAB_GROUP_ID_NONE]));
}

async function organizeTabs(options = {}) {
  const { windowId } = options;
  const previewKey = `preview:${windowId}`;
  const organizeMode = options.organizeMode === "all" ? "all" : "ungrouped";
  const tabs = await extensionApi.tabs.query(Number.isInteger(windowId) ? { windowId } : { lastFocusedWindow: true });
  const eligibleTabs = tabs.filter(isOrganizableTab);
  const skippedTabs = tabs.filter((tab) => !isOrganizableTab(tab));
  const existingGroups = !supportsNativeTabGroups || organizeMode === "all" ? new Map() : await getExistingGroups(windowId);
  // Vivaldi may omit `groupId` altogether because it does not expose its tab
  // stacks through the Chromium tabGroups API. In compatibility mode, every
  // ordinary page is therefore eligible for the safe reordering fallback.
  const ungroupedTabs = supportsNativeTabGroups
    ? eligibleTabs.filter((tab) => !Number.isInteger(tab.groupId) || tab.groupId === TAB_GROUP_ID_NONE)
    : eligibleTabs;
  const targetTabs = organizeMode === "all" ? eligibleTabs : ungroupedTabs;

  if (eligibleTabs.length === 0) {
    return {
      tabCount: 0,
      groups: [],
      source: "local",
      organizeMode,
      warning: "没有拿到可整理的网页标签。请确认当前窗口有普通网页标签，且标签不是固定标签、chrome:// 页面或扩展页面。",
      debug: { proposedGroupCount: 0, failedGroupCount: 0, skippedTabCount: skippedTabs.length }
    };
  }

  if (targetTabs.length === 0) {
    return {
      tabCount: eligibleTabs.length,
      groups: [],
      source: "local",
      organizeMode,
      warning: "未发现未归类标签，已保留现有分组",
      debug: { proposedGroupCount: 0, failedGroupCount: 0, skippedTabCount: skippedTabs.length }
    };
  }

  let grouping;
  if (options.applyPreview) {
    const saved = (await previewStorage.get(previewKey))[previewKey];
    if (!saved || Date.now() - saved.createdAt > 5 * 60 * 1000) {
      throw new Error("预览已过期，请重新预览");
    }
    if (saved.fingerprint !== tabFingerprint(tabs) || saved.organizeMode !== organizeMode) {
      throw new Error("标签页已变化，请重新预览后整理");
    }
    grouping = saved.grouping;
  } else {
    grouping = await buildGroups(targetTabs, options, existingGroups, eligibleTabs);
  }
  const groups = coerceUsefulGroups(normalizeGroups(grouping.groups, targetTabs, existingGroups), targetTabs);
  if (options.previewOnly) {
    await previewStorage.set({ [previewKey]: {
      grouping: { ...grouping, groups }, fingerprint: tabFingerprint(tabs), organizeMode, createdAt: Date.now()
    } });
    return {
      preview: true, groups: groups.map(group => ({
        title: group.title, count: group.tabIds.length,
        tabs: group.tabIds.map(id => targetTabs.find(tab => tab.id === id)?.title || "未命名网页")
      })),
      source: supportsNativeTabGroups ? grouping.source : "vivaldi", organizeMode,
      warning: grouping.warning || "", tabCount: eligibleTabs.length
    };
  }
  const latestTabs = await extensionApi.tabs.query({ windowId });
  if (tabFingerprint(latestTabs) !== tabFingerprint(tabs)) {
    throw new Error("生成方案期间标签页已变化，请重新预览或整理");
  }
  // Consume a preview before the first browser mutation, so it cannot be replayed.
  await previewStorage.remove(previewKey);

  // Vivaldi does not expose a public WebExtension API for creating its native
  // tab stacks or workspaces.  When Chromium's tabGroups API is unavailable,
  // keep every tab in the current window and make each inferred topic a
  // contiguous block instead.  This is a safe, useful fallback that does not
  // create windows, close tabs, or pretend that tab stacks were created.
  if (!supportsNativeTabGroups) {
    return applyVivaldiCompatibility(groups, eligibleTabs, windowId, organizeMode, skippedTabs.length);
  }
  const appliedGroups = [];
  const failedGroups = [];

  if (organizeMode === "all") {
    try {
      await ungroupTabs(targetTabs);
    } catch (error) {
      if (isUnsupportedTabGroupsError(error)) {
        return applyVivaldiCompatibility(groups, eligibleTabs, windowId, organizeMode, skippedTabs.length);
      }
      throw error;
    }
  }

  for (const [index, group] of groups.entries()) {
    const tabIds = group.tabIds.filter((tabId) => eligibleTabs.some((tab) => tab.id === tabId));
    if (tabIds.length < 1) {
      continue;
    }

    try {
      const createdGroup = await createTabGroup({
        tabIds,
        title: group.title,
        existingGroupId: group.existingGroupId,
        color: GROUP_COLORS[index % GROUP_COLORS.length],
        windowId
      });
      appliedGroups.push(createdGroup);
    } catch (error) {
      failedGroups.push({ title: cleanGroupTitle(group.title), count: tabIds.length, error: error.message });
      if (isUnsupportedTabGroupsError(error)) {
        return applyVivaldiCompatibility(groups, eligibleTabs, windowId, organizeMode, skippedTabs.length);
      }
    }
  }

  if (appliedGroups.length === 0 && eligibleTabs.length > 0) {
    try {
      const fallback = buildCatchAllGroup(targetTabs)[0];
      const createdGroup = await createTabGroup({
        tabIds: fallback.tabIds,
        title: fallback.title,
        color: "grey",
        windowId
      });
      appliedGroups.push(createdGroup);
    } catch (error) {
      failedGroups.push({ title: "未分类", count: targetTabs.length, error: error.message });
    }
  }

  return {
    tabCount: eligibleTabs.length,
    groups: appliedGroups,
    source: grouping.source,
    organizeMode,
    warning: grouping.warning || (failedGroups.length ? `创建标签组失败：${failedGroups[0].error}` : ""),
    debug: {
      proposedGroupCount: groups.length,
      failedGroupCount: failedGroups.length,
      skippedTabCount: skippedTabs.length
    }
  };
}

async function applyVivaldiCompatibility(groups, eligibleTabs, windowId, organizeMode, skippedTabCount) {
  const orderedGroups = await arrangeTabsForVivaldi(groups, eligibleTabs, windowId);
  return {
    tabCount: eligibleTabs.length,
    groups: orderedGroups,
    source: "vivaldi",
    organizeMode,
    warning: "Vivaldi 兼容排序：已将同类标签连续排列。Vivaldi 未向扩展开放原生标签栈或工作区的创建接口，因此不会显示 Chrome 式标签组。",
    debug: {
      proposedGroupCount: groups.length,
      failedGroupCount: 0,
      skippedTabCount
    }
  };
}

async function arrangeTabsForVivaldi(groups, eligibleTabs, windowId) {
  const tabById = new Map(eligibleTabs.map((tab) => [tab.id, tab]));
  // Start where the first ordinary page already sits. This preserves pinned
  // tabs and keeps Vivaldi/extension internal pages before it untouched.
  let destinationIndex = Math.min(...eligibleTabs.map((tab) => tab.index));
  const appliedGroups = [];

  for (const group of groups) {
    const orderedTabIds = group.tabIds
      .filter((tabId) => tabById.has(tabId))
      .sort((leftId, rightId) => tabById.get(leftId).index - tabById.get(rightId).index);

    if (!orderedTabIds.length) {
      continue;
    }

    for (const tabId of orderedTabIds) {
      await extensionApi.tabs.move(tabId, {
        index: destinationIndex,
        ...(Number.isInteger(windowId) ? { windowId } : {})
      });
      destinationIndex += 1;
    }

    appliedGroups.push({
      title: cleanGroupTitle(ensureTitleEmoji(group.title)),
      count: orderedTabIds.length
    });
  }

  return appliedGroups;
}

function isUnsupportedTabGroupsError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /not implemented|not supported|unsupported|unavailable|tabgroups|tabs\.group/.test(message);
}

async function buildGroups(tabs, options, existingGroups, allTabs) {
  const saved = await extensionApi.storage.local.get(["apiBaseUrl", "apiKey", "model"]);
  const apiBaseUrl = options.apiBaseUrl || saved.apiBaseUrl;
  const apiKey = options.apiKey || saved.apiKey;
  const model = options.model || saved.model;
  const instructions = normalizeInstructions(options.instructions);
  const localGroups = buildLocalGroups(tabs, instructions, existingGroups);

  if (options.useAi && !apiKey) {
    return {
      groups: localGroups,
      source: "local",
      warning: "未配置 API Key，已回退本地规则"
    };
  }

  if (options.useAi && apiKey) {
    try {
      const aiGroups = await buildAiGroups(tabs, {
        apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
        apiKey,
        model: model || "gpt-4o-mini",
        instructions,
        existingGroups,
        allTabs
      });
      if (aiGroups.length > 0) {
        return { groups: aiGroups, source: "model" };
      }
      return {
        groups: localGroups,
        source: "local",
        warning: "模型没有返回有效分组，已回退本地规则"
      };
    } catch (error) {
      console.warn("AI grouping failed, falling back to local grouping:", error);
      return {
        groups: localGroups,
        source: "local",
        warning: `模型失败，已回退本地规则：${error.message}`
      };
    }
  }

  return { groups: localGroups, source: "local" };
}

async function buildAiGroups(tabs, { apiBaseUrl, apiKey, model, instructions, existingGroups, allTabs }) {
  const indexedTabs = tabs.map((tab) => ({
    id: tab.id,
    index: tab.index,
    title: tab.title || "",
    url: tab.url || "",
    host: safeHost(tab.url)
  }));
  const existingGroupList = buildExistingGroupContext(existingGroups, allTabs);

  const deadline = Date.now() + MODEL_TIMEOUT_MS;
  let response = await fetchChatCompletion({
    deadline,
    apiBaseUrl,
    apiKey,
    model,
    messages: buildMessages(indexedTabs, instructions, existingGroupList),
    useJsonFormat: true
  });

  if (!response.ok && [400, 404, 422].includes(response.status)) {
    response = await fetchChatCompletion({
      deadline,
      apiBaseUrl,
      apiKey,
      model,
      messages: buildMessages(indexedTabs, instructions, existingGroupList),
      useJsonFormat: false
    });
  }

  if (!response.ok) {
    const detail = await safeResponseText(response);
    throw new Error(`模型接口错误：${response.status}${detail ? ` ${detail}` : ""}`);
  }

  const data = response.data;
  const outputText = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(extractJsonObject(outputText));
  return normalizeGroups(parsed.groups, tabs, existingGroups);
}

function buildMessages(indexedTabs, instructions, existingGroups) {
  return [
    {
      role: "system",
      content:
        "你负责整理浏览器标签页。只返回 JSON：{\"groups\":[{\"title\":\"emoji + 中文组名\",\"tabIds\":[1,2],\"existingGroupId\":123}]}。只能处理 ungroupedTabs 里的标签。保留 existingGroups，不要重命名或拆散已有分组；如果未归类标签适合某个已有分组，就填 existingGroupId；否则新建组名，组名必须以一个贴合主题的 emoji 开头，后接简短中文。不要按最近访问时间或互动时间排序，保持每组内清晰合理的标签顺序。"
    },
    {
      role: "user",
      content: JSON.stringify({
        instructions,
        existingGroups,
        ungroupedTabs: indexedTabs
      })
    }
  ];
}

async function fetchChatCompletion({ apiBaseUrl, apiKey, model, messages, useJsonFormat, deadline }) {
  const body = {
    model,
    messages
  };

  if (!/reasoner|reasoning/i.test(model)) {
    body.temperature = 0.2;
  }

  if (useJsonFormat) {
    body.response_format = { type: "json_object" };
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("模型请求超过 12 秒");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);

  try {
    const response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // Keep the abort timer active while reading the response body as well.
    const text = await response.text();
    return { ok: response.ok, status: response.status,
      data: response.ok ? JSON.parse(text) : null, text: async () => text };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`模型请求超过 ${Math.round(MODEL_TIMEOUT_MS / 1000)} 秒`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildLocalGroups(tabs, instructions, existingGroups) {
  const buckets = new Map();

  for (const tab of tabs) {
    const existingGroup = findMatchingExistingGroup(tab, existingGroups);
    const key = existingGroup ? `existing:${existingGroup.id}` : inferChineseTopic(tab);
    const title = existingGroup?.title || key;

    if (!buckets.has(key)) {
      buckets.set(key, {
        title,
        existingGroupId: existingGroup?.id,
        tabIds: []
      });
    }
    buckets.get(key).tabIds.push(tab.id);
  }

  return normalizeGroups(Array.from(buckets.values()), tabs, existingGroups);
}

function buildCatchAllGroup(tabs) {
  return [{ title: "🗂️ 未分类", tabIds: tabs.map((tab) => tab.id).filter(Number.isInteger) }];
}

function coerceUsefulGroups(groups, tabs) {
  if (!groups.length) {
    return buildCatchAllGroup(tabs);
  }

  const assignedTabIds = new Set(groups.flatMap((group) => group.tabIds));
  const missingTabIds = tabs
    .map((tab) => tab.id)
    .filter(Number.isInteger)
    .filter((tabId) => !assignedTabIds.has(tabId));

  const nextGroups = groups.map((group) => ({ ...group, tabIds: [...group.tabIds] }));
  if (missingTabIds.length) {
    nextGroups.push({ title: "🗂️ 未分类", tabIds: missingTabIds });
  }

  return nextGroups;
}

async function createTabGroup({ tabIds, title, existingGroupId, color, windowId }) {
  const groupOptions = { tabIds };
  const isExistingGroup = Number.isInteger(existingGroupId) && existingGroupId !== TAB_GROUP_ID_NONE;
  if (isExistingGroup) {
    groupOptions.groupId = existingGroupId;
  } else if (Number.isInteger(windowId)) {
    groupOptions.createProperties = { windowId };
  }

  const groupId = await extensionApi.tabs.group(groupOptions);
  if (!isExistingGroup) {
    await extensionApi.tabGroups.update(groupId, {
      title: cleanGroupTitle(ensureTitleEmoji(title)),
      color,
      collapsed: false
    });
  }

  return { title: cleanGroupTitle(isExistingGroup ? title : ensureTitleEmoji(title)), count: tabIds.length };
}

async function ungroupTabs(tabs) {
  const groupedTabIds = tabs
    .filter((tab) => Number.isInteger(tab.groupId) && tab.groupId !== TAB_GROUP_ID_NONE)
    .map((tab) => tab.id)
    .filter(Number.isInteger);

  if (!groupedTabIds.length) {
    return;
  }

  await extensionApi.tabs.ungroup(groupedTabIds);
}

function normalizeGroups(groups, tabs, existingGroups = new Map()) {
  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const seen = new Set();

  return (Array.isArray(groups) ? groups : [])
    .filter((group) => group && typeof group === "object")
    .map((group) => {
      const parsedExistingGroupId = Number(group.existingGroupId);
      const existingGroupId = Number.isInteger(parsedExistingGroupId) && existingGroups.has(parsedExistingGroupId)
        ? parsedExistingGroupId
        : undefined;
      const existingTitle = existingGroupId !== undefined ? existingGroups.get(existingGroupId)?.title : "";

      return {
        title: cleanGroupTitle(existingTitle || ensureTitleEmoji(group.title)),
        existingGroupId,
        tabIds: [...new Set(Array.isArray(group.tabIds) ? group.tabIds : [])]
          .filter((tabId) => validTabIds.has(tabId))
          .filter((tabId) => {
            if (seen.has(tabId)) {
              return false;
            }
            seen.add(tabId);
            return true;
          })
      };
    })
    .filter((group) => group.title && group.tabIds.length > 0);
}

async function getExistingGroups(windowId) {
  try {
    const query = Number.isInteger(windowId) ? { windowId } : {};
    const groups = await extensionApi.tabGroups.query(query);
    return new Map(
      groups.map((group) => [
        group.id,
        {
          id: group.id,
          title: cleanGroupTitle(group.title || "未命名分组"),
          color: group.color
        }
      ])
    );
  } catch (error) {
    console.warn("Failed to query existing tab groups:", error);
    return new Map();
  }
}

function buildExistingGroupContext(existingGroups, allTabs = []) {
  return Array.from(existingGroups.values()).map((group) => ({
    id: group.id,
    title: group.title,
    sampleTabs: allTabs
      .filter((tab) => tab.groupId === group.id)
      .slice(0, 5)
      .map((tab) => ({
        title: tab.title || "",
        url: tab.url || "",
        host: safeHost(tab.url)
      }))
  }));
}

function findMatchingExistingGroup(tab, existingGroups) {
  const topic = normalizeForMatch(inferChineseTopic(tab));
  const host = normalizeForMatch(safeHost(tab.url).replace(/^www\./, ""));
  const hostBucket = normalizeForMatch(getHostBucket(tab.url));
  const title = normalizeForMatch(tab.title || "");

  for (const group of existingGroups.values()) {
    const groupTitle = normalizeForMatch(group.title);
    if (!groupTitle) {
      continue;
    }

    if (
      (topic !== "网页资料" && (groupTitle.includes(topic) || topic.includes(groupTitle))) ||
      groupTitle.includes(hostBucket) ||
      hostBucket.includes(groupTitle) ||
      host.includes(groupTitle) ||
      title.includes(groupTitle)
    ) {
      return group;
    }
  }

  return null;
}

function inferChineseTopic(tab) {
  const host = safeHost(tab.url).toLowerCase();
  const text = `${tab.title || ""} ${tab.url || ""}`.toLowerCase();
  const at = (...domains) => domains.some(domain => host === domain || host.endsWith(`.${domain}`));

  if (host === "localhost" || host.endsWith(".localhost") || /^(127\.|192\.168\.|10\.)/.test(host) || host === "0.0.0.0" || host === "[::1]") return "本地开发";
  // Specific services must precede broad title keywords such as docs and video.
  if (at("chatgpt.com", "openai.com", "claude.ai", "deepseek.com", "gemini.google.com", "grok.com", "perplexity.ai")) return "AI 工具";
  if (at("docs.google.com", "sheets.google.com", "drive.google.com", "notion.so", "notion.site", "yuque.com", "feishu.cn")) return "文档资料";
  if (at("gmail.com", "mail.google.com", "calendar.google.com")) return "谷歌工具";
  if (at("linux.do", "v2ex.com", "reddit.com") || /论坛|社区/.test(text)) return "技术社区";
  if (at("youtube.com", "youtu.be", "bilibili.com", "douyin.com", "kuaishou.com")) return "视频内容";
  if (at("taobao.com", "tmall.com", "jd.com", "amazon.com")) return "购物资料";
  if (at("xueqiu.com", "eastmoney.com", "10jqka.com", "binance.com", "tradingview.com")) return "投资研究";
  if (at("google.com", "bing.com", "baidu.com", "duckduckgo.com") && /[/?](search|s|q)([/?=]|$)/.test(tab.url || "")) return "搜索资料";
  if (at("github.com", "gitlab.com", "bitbucket.org", "npmjs.com", "stackoverflow.com", "vercel.com", "cloudflare.com") || /(^|\.)docs\./.test(host) || /developer|开发文档|api文档|mdn/.test(text)) return "开发资料";
  if (/搜索/.test(text)) return "搜索资料";
  if (/视频|\.mp4(?:[?#]|$)/.test(text)) return "视频内容";
  if (/购物|商品|购物车/.test(text)) return "购物资料";
  if (/finance|stock|invest|股票|投资/.test(text)) return "投资研究";
  if (/document|\.pdf(?:[?#]|$)|文档|表格|幻灯片/.test(text)) return "文档资料";

  return "网页资料";
}

function ensureTitleEmoji(title = "") {
  const value = String(title).trim();
  if (!value) {
    return "🗂️ 未分类";
  }
  if (hasLeadingEmoji(value)) {
    return value;
  }
  return `${emojiForTitle(value)} ${value}`;
}

function hasLeadingEmoji(value) {
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(String(value).trim());
}

function emojiForTitle(title = "") {
  const value = normalizeForMatch(title);

  if (/本地|开发|代码|github|gitlab|api/.test(value)) {
    return "💻";
  }
  if (/搜索|研究/.test(value)) {
    return "🔎";
  }
  if (/文档|表格|幻灯片|pdf|notion|飞书|语雀/.test(value)) {
    return "📄";
  }
  if (/谷歌|工具|gmail|drive|docs|ai/.test(value)) {
    return "🧰";
  }
  if (/社区|论坛|linux|v2ex|reddit/.test(value)) {
    return "💬";
  }
  if (/视频|影音|youtube|bilibili|媒体/.test(value)) {
    return "🎬";
  }
  if (/购物|商品|订单|电商/.test(value)) {
    return "🛒";
  }
  if (/投资|股票|财经|金融/.test(value)) {
    return "📈";
  }
  if (/工作|项目|任务|协同/.test(value)) {
    return "📌";
  }

  return "🗂️";
}

function normalizeInstructions(value) {
  return String(value || "").trim() || DEFAULT_INSTRUCTIONS;
}

function normalizeForMatch(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, "");
}

function cleanGroupTitle(title = "") {
  const normalized = String(title).trim().replace(/\s+/g, " ");
  return Array.from(normalized).slice(0, 22).join("") || "🗂️ 标签";
}

function getHostBucket(url) {
  const host = safeHost(url);
  if (!host) {
    return "Other";
  }

  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length >= 2) {
    return titleCase(parts.at(-2));
  }
  return titleCase(parts[0]);
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function titleCase(value = "") {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function isOrganizableTab(tab) {
  return Boolean(tab.id && !tab.pinned && tab.url && /^(https?|file):/.test(tab.url));
}

function normalizeBaseUrl(value) {
  return (value || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  if (value.startsWith("{") && value.endsWith("}")) {
    return value;
  }

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return value.slice(start, end + 1);
  }

  throw new Error("模型没有返回可解析的 JSON 分组结果");
}

async function safeResponseText(response) {
  try {
    const text = await response.text();
    return text.slice(0, 180).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}
