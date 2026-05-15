const GROUP_COLORS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange", "pink", "grey"];
const MODEL_TIMEOUT_MS = 12000;
const TAB_GROUP_ID_NONE = -1;
const DEFAULT_INSTRUCTIONS = `依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料`;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ORGANIZE_TABS") {
    return false;
  }

  organizeTabs(message.payload)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function organizeTabs(options = {}) {
  const { windowId } = options;
  const organizeMode = options.organizeMode === "all" ? "all" : "ungrouped";
  const tabs = await chrome.tabs.query(Number.isInteger(windowId) ? { windowId } : { lastFocusedWindow: true });
  const eligibleTabs = tabs.filter(isOrganizableTab);
  const skippedTabs = tabs.filter((tab) => !isOrganizableTab(tab));
  const existingGroups = organizeMode === "all" ? new Map() : await getExistingGroups(windowId);
  const ungroupedTabs = eligibleTabs.filter((tab) => tab.groupId === TAB_GROUP_ID_NONE);
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

  const grouping = await buildGroups(targetTabs, options, existingGroups, eligibleTabs);
  const groups = coerceUsefulGroups(grouping.groups, targetTabs);
  const appliedGroups = [];
  const failedGroups = [];

  if (organizeMode === "all") {
    await ungroupTabs(targetTabs);
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

async function buildGroups(tabs, options, existingGroups, allTabs) {
  const saved = await chrome.storage.local.get(["apiBaseUrl", "apiKey", "model"]);
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

  let response = await fetchChatCompletion({
    apiBaseUrl,
    apiKey,
    model,
    messages: buildMessages(indexedTabs, instructions, existingGroupList),
    useJsonFormat: true
  });

  if (!response.ok && [400, 404, 422].includes(response.status)) {
    response = await fetchChatCompletion({
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

  const data = await response.json();
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

async function fetchChatCompletion({ apiBaseUrl, apiKey, model, messages, useJsonFormat }) {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    return await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
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

  const groupId = await chrome.tabs.group(groupOptions);
  if (!isExistingGroup) {
    await chrome.tabGroups.update(groupId, {
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

  await chrome.tabs.ungroup(groupedTabIds);
}

function normalizeGroups(groups, tabs, existingGroups = new Map()) {
  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const seen = new Set();

  return groups
    .map((group) => {
      const parsedExistingGroupId = Number(group.existingGroupId);
      const existingGroupId = Number.isInteger(parsedExistingGroupId) && existingGroups.has(parsedExistingGroupId)
        ? parsedExistingGroupId
        : undefined;
      const existingTitle = existingGroupId !== undefined ? existingGroups.get(existingGroupId)?.title : "";

      return {
        title: cleanGroupTitle(existingTitle || ensureTitleEmoji(group.title)),
        existingGroupId,
        tabIds: [...new Set(group.tabIds || [])]
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
    const groups = await chrome.tabGroups.query(query);
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
      groupTitle.includes(topic) ||
      topic.includes(groupTitle) ||
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
  const host = safeHost(tab.url);
  const text = `${tab.title || ""} ${tab.url || ""} ${host}`.toLowerCase();

  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{2,5}/.test(text)) {
    return "本地开发";
  }
  if (/github|gitlab|bitbucket|npmjs|stackoverflow|developer|docs\.|api|mdn|vercel|cloudflare/.test(text)) {
    return "开发资料";
  }
  if (/search|google 搜索|bing|baidu|duckduckgo|搜索/.test(text)) {
    return "搜索资料";
  }
  if (/drive\.google|docs\.google|sheets\.google|gmail|calendar\.google|google ai|google/.test(text)) {
    return "谷歌工具";
  }
  if (/linux\.do|v2ex|reddit|forum|community|discourse|论坛|社区/.test(text)) {
    return "技术社区";
  }
  if (/youtube|bilibili|video|mp4|douyin|kuaishou|视频/.test(text)) {
    return "视频内容";
  }
  if (/amazon|taobao|tmall|jd\.com|shop|product|cart|购物|商品/.test(text)) {
    return "购物资料";
  }
  if (/finance|stock|invest|雪球|东方财富|同花顺|股票|投资/.test(text)) {
    return "投资研究";
  }
  if (/notion|yuque|feishu|document|pdf|文档|表格|幻灯片/.test(text)) {
    return "文档资料";
  }

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
  return /^\p{Extended_Pictographic}/u.test(String(value).trim());
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
    .replace(/\p{Extended_Pictographic}/gu, "")
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
