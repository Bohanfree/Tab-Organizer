const tabCount = document.querySelector("#tabCount");
const instructions = document.querySelector("#instructions");
const useAi = document.querySelector("#useAi");
const organizeModeButtons = [...document.querySelectorAll("[data-mode]")];
const apiBaseUrl = document.querySelector("#apiBaseUrl");
const apiKey = document.querySelector("#apiKey");
const model = document.querySelector("#model");
const organize = document.querySelector("#organize");
const result = document.querySelector("#result");
const settings = document.querySelector("#settings");
const settingsToggle = document.querySelector("#settingsToggle");
const saveSettings = document.querySelector("#saveSettings");
const version = document.querySelector("#version");
const extensionApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";
const POPUP_TIMEOUT_MS = 18000;
const DEFAULT_INSTRUCTIONS = `依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料`;
let currentWindowId = null;
let currentOrganizeMode = "ungrouped";

init();

async function init() {
  const [{ apiBaseUrl: savedBaseUrl, apiKey: savedKey, model: savedModel, useAi: savedUseAi, instructions: savedInstructions, organizeMode }, currentWindow] =
    await Promise.all([
      extensionApi.storage.local.get(["apiBaseUrl", "apiKey", "model", "useAi", "instructions", "organizeMode"]),
      extensionApi.windows.getCurrent({ populate: true })
    ]);

  currentWindowId = currentWindow.id;
  const tabs = currentWindow.tabs || [];
  version.textContent = `v${extensionApi.runtime.getManifest().version}`;
  apiBaseUrl.value = savedBaseUrl || "https://api.openai.com/v1";
  apiKey.value = savedKey || "";
  model.value = savedModel || "gpt-4o-mini";
  useAi.checked = Boolean(savedUseAi);
  setOrganizeMode(organizeMode || "ungrouped");
  instructions.value = savedInstructions || DEFAULT_INSTRUCTIONS;
  tabCount.textContent = `${tabs.length} 个标签页，当前窗口`;
}

settingsToggle.addEventListener("click", () => {
  settings.classList.toggle("hidden");
});

for (const button of organizeModeButtons) {
  button.addEventListener("click", () => {
    setOrganizeMode(button.dataset.mode);
  });
}

saveSettings.addEventListener("click", async () => {
  await extensionApi.storage.local.set({
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl.value),
    apiKey: apiKey.value.trim(),
    model: model.value.trim() || "gpt-4o-mini",
    useAi: useAi.checked,
    instructions: instructions.value.trim() || DEFAULT_INSTRUCTIONS,
    organizeMode: getOrganizeMode()
  });
  showMessage("设置已保存。");
});

organize.addEventListener("click", async () => {
  organize.disabled = true;
  organize.textContent = "正在整理...";
  showMessage("");

  try {
    const settings = {
      apiBaseUrl: normalizeBaseUrl(apiBaseUrl.value),
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || "gpt-4o-mini",
      useAi: useAi.checked,
      instructions: instructions.value.trim() || DEFAULT_INSTRUCTIONS,
      organizeMode: getOrganizeMode(),
      windowId: currentWindowId
    };

    if (settings.useAi && settings.apiKey) {
      await ensureApiPermission(settings.apiBaseUrl);
    }

    await extensionApi.storage.local.set(settings);

    const response = await sendMessageWithTimeout(
      {
        type: "ORGANIZE_TABS",
        payload: settings
      },
      POPUP_TIMEOUT_MS
    );

    if (!response?.ok) {
      throw new Error(response?.error || "整理失败");
    }

    showResult(response);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    organize.disabled = false;
    organize.textContent = "整理当前窗口标签";
  }
});

function showMessage(message, isError = false) {
  result.textContent = message;
  result.classList.toggle("visible", Boolean(message));
  result.classList.toggle("error", isError);
}

function showResult(response) {
  const groupText = response.groups
    .map((group) => `${group.title}（${group.count}）`)
    .join("、");
  const sourceText = response.source === "model" ? "模型" : "本地规则";
  const modeText = response.organizeMode === "all" ? "全部重整" : "未归类";
  const detailText = response.debug
    ? `范围：${modeText}；来源：${sourceText}；候选 ${response.debug.proposedGroupCount} 组，失败 ${response.debug.failedGroupCount} 组，跳过 ${response.debug.skippedTabCount || 0} 个`
    : `范围：${modeText}；来源：${sourceText}`;

  result.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = response.groups.length
    ? `已整理 ${response.groups.reduce((sum, group) => sum + group.count, 0)} 个标签`
    : response.warning || "没有需要整理的标签";
  result.append(title);

  if (groupText) {
    const summary = document.createElement("div");
    summary.textContent = groupText;
    result.append(summary);
  }

  const details = document.createElement("details");
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "详情";
  const detailsBody = document.createElement("div");
  detailsBody.textContent = [detailText, response.warning].filter(Boolean).join("；");
  details.append(detailsSummary, detailsBody);
  result.append(details);

  result.classList.add("visible");
  result.classList.remove("error");
}

function normalizeBaseUrl(value) {
  return (value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function getOrganizeMode() {
  return currentOrganizeMode;
}

function setOrganizeMode(value) {
  const mode = value === "all" ? "all" : "ungrouped";
  currentOrganizeMode = mode;
  for (const button of organizeModeButtons) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  }
}

async function ensureApiPermission(baseUrl) {
  const origin = getOriginPattern(baseUrl);
  const hasPermission = await extensionApi.permissions.contains({ origins: [origin] });
  if (hasPermission) {
    return;
  }

  const granted = await extensionApi.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error("未授权访问模型接口，已取消模型分组");
  }
}

function getOriginPattern(baseUrl) {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    throw new Error("API Base URL 格式不正确");
  }
}

function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`整理超时：后台超过 ${Math.round(timeoutMs / 1000)} 秒未响应，请刷新扩展或关闭模型分组重试`));
    }, timeoutMs);

    if (usesPromiseApi) {
      extensionApi.runtime.sendMessage(message)
        .then((response) => {
          clearTimeout(timer);
          resolve(response);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
      return;
    }

    extensionApi.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const runtimeError = extensionApi.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}
