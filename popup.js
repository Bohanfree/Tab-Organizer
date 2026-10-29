const tabCount = document.querySelector("#tabCount");
const instructions = document.querySelector("#instructions");
const useAi = document.querySelector("#useAi");
const organizeModeButtons = [...document.querySelectorAll("[data-mode]")];
const apiBaseUrl = document.querySelector("#apiBaseUrl");
const apiKey = document.querySelector("#apiKey");
const model = document.querySelector("#model");
const organize = document.querySelector("#organize");
const preview = document.querySelector("#preview");
const applyPreview = document.querySelector("#applyPreview");
const result = document.querySelector("#result");
const settings = document.querySelector("#settings");
const settingsToggle = document.querySelector("#settingsToggle");
const saveSettings = document.querySelector("#saveSettings");
const version = document.querySelector("#version");
const extensionApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";
const POPUP_TIMEOUT_MS = 45000;
const DEFAULT_INSTRUCTIONS = `依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料`;
let currentWindowId = null;
let currentOrganizeMode = "ungrouped";

init().catch(error => showMessage(`读取失败：${error.message}`, true));

async function init() {
  const [{ apiBaseUrl: savedBaseUrl, apiKey: savedKey, model: savedModel, useAi: savedUseAi, instructions: savedInstructions, organizeMode }, tabs] =
    await Promise.all([
      extensionApi.storage.local.get(["apiBaseUrl", "apiKey", "model", "useAi", "instructions", "organizeMode"]),
      extensionApi.tabs.query({ currentWindow: true })
    ]);

  currentWindowId = tabs[0]?.windowId ?? null;
  version.textContent = `v${extensionApi.runtime.getManifest().version}`;
  apiBaseUrl.value = savedBaseUrl || "https://api.openai.com/v1";
  apiKey.value = savedKey || "";
  model.value = savedModel || "gpt-4o-mini";
  useAi.checked = Boolean(savedUseAi);
  setOrganizeMode(organizeMode || "ungrouped");
  instructions.value = savedInstructions || DEFAULT_INSTRUCTIONS;
  const eligible = tabs.filter(tab => !tab.pinned && /^(https?|file):/.test(tab.url || ""));
  tabCount.textContent = `${tabs.length} 个标签页 · ${eligible.length} 个可整理`;
  const resultKey = `lastResult:${currentWindowId}`;
  const lastResult = (await extensionApi.storage.local.get(resultKey))[resultKey];
  if (lastResult) showResult(lastResult, true);
  organize.disabled = false;
  preview.disabled = false;
}

settingsToggle.addEventListener("click", () => {
  settings.classList.toggle("hidden");
});

for (const button of organizeModeButtons) {
  button.addEventListener("click", () => {
    setOrganizeMode(button.dataset.mode);
    extensionApi.storage.local.set({ organizeMode: getOrganizeMode() })
      .catch(error => showMessage(error.message, true));
  });
}

saveSettings.addEventListener("click", async () => {
  try {
    await extensionApi.storage.local.set({
      apiBaseUrl: normalizeBaseUrl(apiBaseUrl.value),
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || "gpt-4o-mini",
      useAi: useAi.checked,
      instructions: instructions.value.trim() || DEFAULT_INSTRUCTIONS,
      organizeMode: getOrganizeMode()
    });
    showMessage("设置已保存。");
  } catch (error) {
    showMessage(error.message, true);
  }
});

organize.addEventListener("click", () => runOperation("ORGANIZE_TABS"));
preview.addEventListener("click", () => runOperation("PREVIEW_TABS"));
applyPreview.addEventListener("click", () => runOperation("APPLY_PREVIEW"));

function invalidatePreview() {
  applyPreview.classList.add("hidden");
}

for (const input of [instructions, useAi, apiBaseUrl, apiKey, model]) {
  input.addEventListener("input", invalidatePreview);
}
for (const input of [instructions, useAi]) {
  input.addEventListener("change", () => extensionApi.storage.local.set({
    instructions: instructions.value.trim() || DEFAULT_INSTRUCTIONS, useAi: useAi.checked
  }).catch(error => showMessage(error.message, true)));
}

async function runOperation(type) {
  for (const button of [organize, preview, applyPreview]) button.disabled = true;
  organize.textContent = type === "PREVIEW_TABS" ? "正在生成预览..." : "正在整理...";
  invalidatePreview();
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
    // Applying a stored preview does not call the model again.
    const permissionRequest = type !== "APPLY_PREVIEW" && settings.useAi && settings.apiKey
      ? requestApiPermissionFromGesture(settings.apiBaseUrl) : null;
    if (permissionRequest && !await permissionRequest) {
      throw new Error("未授权访问模型接口，已取消模型分组");
    }
    await extensionApi.storage.local.set(settings);
    const response = await sendMessageWithTimeout({ type, payload: settings }, POPUP_TIMEOUT_MS);
    if (!response?.ok) throw new Error(response?.error || "整理失败");
    if (response.preview) {
      showPreview(response);
      applyPreview.classList.remove("hidden");
    } else {
      showResult(response);
    }
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    for (const button of [organize, preview, applyPreview]) button.disabled = false;
    organize.textContent = "整理当前窗口标签";
  }
}

function showPreview(response) {
  showMessage("");
  const heading = document.createElement("strong");
  heading.textContent = `预计整理 ${response.groups.reduce((sum, group) => sum + group.count, 0)} 个标签，${response.groups.length} 组`;
  result.append(heading);
  const hint = document.createElement("div");
  hint.textContent = "展开组名可查看标签；预览有效期 5 分钟。";
  result.append(hint);
  for (const group of response.groups) {
    const details = document.createElement("details");
    details.className = "preview-group";
    const summary = document.createElement("summary");
    summary.textContent = `${group.title}（${group.count}）`;
    const list = document.createElement("ul");
    for (const title of group.tabs) {
      const item = document.createElement("li");
      item.textContent = title;
      list.append(item);
    }
    details.append(summary, list);
    result.append(details);
  }
  if (response.warning) {
    const warning = document.createElement("p");
    warning.textContent = response.warning;
    result.append(warning);
  }
  result.classList.add("visible");
}

function showMessage(message, isError = false) {
  result.textContent = message;
  result.classList.toggle("visible", Boolean(message));
  result.classList.toggle("error", isError);
}

function showResult(response, restored = false) {
  const groupText = response.groups
    .map((group) => `${group.title}（${group.count}）`)
    .join("、");
  const sourceText = response.source === "model"
    ? "模型"
    : response.source === "vivaldi"
      ? "Vivaldi 兼容排序"
      : "本地规则";
  const modeText = response.organizeMode === "all" ? "全部重整" : "未归类";
  const detailText = response.debug
    ? `范围：${modeText}；来源：${sourceText}；候选 ${response.debug.proposedGroupCount} 组，失败 ${response.debug.failedGroupCount} 组，跳过 ${response.debug.skippedTabCount || 0} 个`
    : `范围：${modeText}；来源：${sourceText}`;

  result.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = response.groups.length
    ? `已整理 ${response.groups.reduce((sum, group) => sum + group.count, 0)} 个标签`
    : response.warning || "没有需要整理的标签";
  if (restored) title.textContent = `上次整理（${new Date(response.savedAt).toLocaleTimeString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）：${title.textContent}`;
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
  invalidatePreview();
  for (const button of organizeModeButtons) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  }
}

function requestApiPermissionFromGesture(baseUrl) {
  const origin = getOriginPattern(baseUrl);
  return extensionApi.permissions.request({ origins: [origin] });
}

function getOriginPattern(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return `${url.origin}/*`;
  } catch {
    throw new Error("API Base URL 格式不正确");
  }
}

function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`后台超过 ${Math.round(timeoutMs / 1000)} 秒未响应；稍后重新打开弹窗查看结果`));
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
