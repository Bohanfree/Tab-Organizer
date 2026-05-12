const tabCount = document.querySelector("#tabCount");
const instructions = document.querySelector("#instructions");
const useAi = document.querySelector("#useAi");
const apiBaseUrl = document.querySelector("#apiBaseUrl");
const apiKey = document.querySelector("#apiKey");
const model = document.querySelector("#model");
const organize = document.querySelector("#organize");
const result = document.querySelector("#result");
const settings = document.querySelector("#settings");
const settingsToggle = document.querySelector("#settingsToggle");
const saveSettings = document.querySelector("#saveSettings");
const version = document.querySelector("#version");
const POPUP_TIMEOUT_MS = 18000;
const DEFAULT_INSTRUCTIONS = `依据页面标题和 URL，按主题对标签页进行分组；每组内保持清晰、合理的排序。

请勿依据最近访问时间或互动时间排序。

保留现有分组，若未归类标签不适合归入现有分组，则为其新建分组。
新建分组标签页名用 emoji + 中文，例如：💻 开发资料`;
let currentWindowId = null;

init();

async function init() {
  const [{ apiBaseUrl: savedBaseUrl, apiKey: savedKey, model: savedModel, useAi: savedUseAi, instructions: savedInstructions }, currentWindow] =
    await Promise.all([
      chrome.storage.local.get(["apiBaseUrl", "apiKey", "model", "useAi", "instructions"]),
      chrome.windows.getCurrent({ populate: true })
    ]);

  currentWindowId = currentWindow.id;
  const tabs = currentWindow.tabs || [];
  version.textContent = `v${chrome.runtime.getManifest().version}`;
  apiBaseUrl.value = savedBaseUrl || "https://api.openai.com/v1";
  apiKey.value = savedKey || "";
  model.value = savedModel || "gpt-4o-mini";
  useAi.checked = Boolean(savedUseAi);
  instructions.value = savedInstructions || DEFAULT_INSTRUCTIONS;
  tabCount.textContent = `${tabs.length} 个标签页，当前窗口`;
}

settingsToggle.addEventListener("click", () => {
  settings.classList.toggle("hidden");
});

saveSettings.addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiBaseUrl: normalizeBaseUrl(apiBaseUrl.value),
    apiKey: apiKey.value.trim(),
    model: model.value.trim() || "gpt-4o-mini",
    useAi: useAi.checked,
    instructions: instructions.value.trim() || DEFAULT_INSTRUCTIONS
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
      windowId: currentWindowId
    };

    await chrome.storage.local.set(settings);

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

    const groupText = response.groups
      .map((group) => `${group.title}（${group.count}）`)
      .join("、");
    const sourceText = response.source === "model" ? "模型分组" : "本地规则";
    const warningText = response.warning ? `；${response.warning}` : "";
    const debugText = response.debug
      ? `；候选 ${response.debug.proposedGroupCount} 组，失败 ${response.debug.failedGroupCount} 组，跳过 ${response.debug.skippedTabCount || 0} 个`
      : "";
    showMessage(`已整理 ${response.tabCount} 个标签（${sourceText}${warningText}${debugText}）：${groupText || "未能创建标签组"}`);
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

function normalizeBaseUrl(value) {
  return (value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`整理超时：后台超过 ${Math.round(timeoutMs / 1000)} 秒未响应，请刷新扩展或关闭模型分组重试`));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}
