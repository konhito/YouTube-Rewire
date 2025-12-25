// Popup UI logic: load/save keywords, start/stop, show status and logs.

const DEFAULT = ["popular tech news", "trending music", "funny cat videos"];

const $ = (id) => document.getElementById(id);

async function loadState() {
  const s = await new Promise((r) => chrome.storage.local.get(null, r));
  const keywords = (s.keywords && s.keywords.join(", ")) || DEFAULT.join(", ");
  $("keywords").value = keywords;
  $("topic").value = s.lastTopic || "";
  $("apiKey").value = s.apiKey ? "********" : "";
  updateStatus(s);
  renderLogs(s.logs || []);
  setRunningUI(!!s.isRunning);
}

// Small toast helper for animated notifications
function showToast(msg, timeout = 4500, type = "") {
  const t = $("toast");
  if (!t) return; // fallback
  t.textContent = msg;
  t.classList.remove("success", "error");
  if (type) t.classList.add(type);
  t.classList.add("show");
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove("show"), timeout);
}

// Generate keywords using Gemini via background
$("generateBtn").addEventListener("click", async () => {
  const topic = $("topic").value.trim();
  if (!topic)
    return showToast(
      "Please enter a topic to generate keywords for.",
      4500,
      "error"
    );
  // Save the last topic locally for convenience
  await new Promise((r) => chrome.storage.local.set({ lastTopic: topic }, r));

  // Resolve API key: prefer explicit input, but allow masked to use stored key
  let apiKeyInput = $("apiKey").value.trim();
  let resolvedKey = "";
  if (apiKeyInput === "********") {
    const s = await new Promise((r) => chrome.storage.local.get(["apiKey"], r));
    resolvedKey = s.apiKey || "";
  } else if (apiKeyInput) {
    resolvedKey = apiKeyInput;
  }
  if (!resolvedKey) {
    return showToast(
      "An API key is required to generate. Paste it and click Save.",
      5000,
      "error"
    );
  }

  // Indicate loading state
  setRunningUI(true);
  $("generateBtn").disabled = true;
  $("generateBtn").innerHTML = 'Generating <span class="spinner"></span>';

  // Make request to background which will call the API
  chrome.runtime.sendMessage({ action: "generateKeywords", topic }, (resp) => {
    $("generateBtn").disabled = false;
    $("generateBtn").innerHTML = "Generate";
    setRunningUI(false);

    if (!resp) {
      showToast("Generation failed (no response).", 6000, "error");
      return;
    }
    if (resp.error) {
      showToast("Error: " + resp.error, 6500, "error");
      return;
    }
    const kws = (resp.keywords && resp.keywords.join(", ")) || "";
    if (kws) {
      $("keywords").value = kws;
      showToast("Keywords generated successfully", 3800, "success");
    } else {
      showToast("No keywords returned.", 4500, "error");
    }
  });
});

// Save API key button
$("saveKeyBtn").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return showToast("Enter a key to save.", 3500, "error");
  if (key === "********") return showToast("Key already saved.", 3000, "error");
  await new Promise((r) => chrome.storage.local.set({ apiKey: key }, r));
  $("apiKey").value = "********";
  showToast("API key saved locally.", 3000, "success");
});

// Clear API key button
$("clearKeyBtn").addEventListener("click", async () => {
  await new Promise((r) => chrome.storage.local.remove(["apiKey"], r));
  $("apiKey").value = "";
  $("showKeyBtn").textContent = "Show";
  showToast("API key cleared.", 3000, "success");
});

// Show/Hide API key
$("showKeyBtn").addEventListener("click", async () => {
  const cur = $("apiKey").value;
  if (cur === "********") {
    const s = await new Promise((r) => chrome.storage.local.get(["apiKey"], r));
    if (s.apiKey) {
      $("apiKey").value = s.apiKey;
      $("showKeyBtn").textContent = "Hide";
    } else showToast("No key saved.", 3000, "error");
  } else {
    $("apiKey").value = "********";
    $("showKeyBtn").textContent = "Show";
  }
});
function updateStatus(s) {
  const isRunning = s.isRunning;
  const daysCompleted = s.daysCompleted || 0;
  const startTs = s.startTs ? new Date(s.startTs).toLocaleString() : "—";
  const keywords = (s.keywords || DEFAULT).slice(0, 5).join(", ");
  $("status").textContent = isRunning
    ? `Running — Day ${daysCompleted}/${7} • Keywords: ${keywords}`
    : `Idle — last started: ${startTs}`;
}

function renderLogs(logs) {
  const el = $("logs");
  if (!logs.length) {
    el.textContent = "No logs yet.";
    return;
  }
  const shown = logs.slice(0, 10);
  el.innerHTML = shown
    .map((l) => {
      const time = l.ts
        ? new Date(l.ts).toLocaleString()
        : new Date().toLocaleString();
      if (l.success)
        return `<div class="log-item">✅ ${time} — "${
          l.keyword
        }" watched ${Math.round(l.watchSeconds)}s</div>`;
      return `<div class="log-item">⚠️ ${time} — ${l.error || "failed"}</div>`;
    })
    .join("");
}

function setRunningUI(isRunning) {
  $("startBtn").disabled = isRunning;
  $("stopBtn").disabled = !isRunning;
}

$("startBtn").addEventListener("click", async () => {
  const raw = $("keywords").value.trim();
  const kw = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
    : DEFAULT;
  // Save keywords
  await new Promise((r) => chrome.storage.local.set({ keywords: kw }, r));
  // send start message
  chrome.runtime.sendMessage({ action: "start", keywords: kw }, (res) => {
    // give immediate UI feedback
    setRunningUI(true);
    showToast("Boost started", 3000, "success");
    setTimeout(() => window.close(), 600);
  });
});

$("stopBtn").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ action: "stop" }, (res) => {
    setRunningUI(false);
    showToast("Boost stopped", 3000, "success");
    setTimeout(() => window.close(), 600);
  });
});

// Clear logs button
$("clearLogsBtn").addEventListener("click", async () => {
  await new Promise((r) => chrome.storage.local.set({ logs: [] }, r));
  loadState();
});

// Update UI when popup opens
document.addEventListener("DOMContentLoaded", () => {
  loadState();
  // subtle entrance animation
  const c = document.querySelector(".container");
  if (c) c.classList.add("fade-in");
  // refresh periodically while popup is open
  setInterval(loadState, 2000);
});
