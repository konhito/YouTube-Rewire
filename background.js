// Background service worker (Manifest V3)
// Handles scheduling, alarms, and coordination with content scripts.

const CONFIG = {
  days: 7,
  minSessionsPerDay: 3,
  maxSessionsPerDay: 5,
  minBetweenHours: 2,
  maxBetweenHours: 6,
  maxWatchSeconds: 15 * 60, // 15 minutes cap
  defaultKeywords: ["popular tech news", "trending music", "funny cat videos"],
  maxLogs: 50,
};

// Utility
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Storage helpers
async function getStore(keys = null) {
  return new Promise((resolve) =>
    chrome.storage.local.get(keys, (res) => resolve(res))
  );
}
async function setStore(obj) {
  return new Promise((resolve) =>
    chrome.storage.local.set(obj, () => resolve())
  );
}

// Generate a schedule of absolute timestamps (ms since epoch) for sessions
function generateSchedule(startTs) {
  const schedule = [];
  for (let day = 0; day < CONFIG.days; day++) {
    const sessionCount = randInt(
      CONFIG.minSessionsPerDay,
      CONFIG.maxSessionsPerDay
    );
    // For simplicity, create sessions sequentially each day with random gaps 2-6 hours
    let ts = startTs + day * 24 * 60 * 60 * 1000;
    // add an initial offset in the day (0-6 hours)
    ts += rand(0, 6 * 60 * 60 * 1000);
    for (let s = 0; s < sessionCount; s++) {
      schedule.push(ts);
      // add random gap between sessions (2-6 hours)
      ts += rand(
        CONFIG.minBetweenHours * 60 * 60 * 1000,
        CONFIG.maxBetweenHours * 60 * 60 * 1000
      );
    }
  }
  return schedule;
}

// Create alarms for each timestamp
async function scheduleAlarmsForRun(runId, startTs, keywords) {
  const schedule = generateSchedule(startTs);
  const alarmsMeta = [];
  for (const ts of schedule) {
    const name = `session-${runId}-${ts}`;
    alarmsMeta.push({ name, ts });
    chrome.alarms.create(name, { when: ts });
  }
  // Save metadata
  const meta = await getStore();
  meta.currentRun = {
    id: runId,
    startTs,
    schedule,
    keywords,
    createdAt: Date.now(),
  };
  await setStore({ ...meta });
}

// Cancel all session alarms for a particular run id
function cancelRunAlarms(runId) {
  chrome.alarms.getAll((all) => {
    for (const a of all) {
      if (a.name.startsWith(`session-${runId}-`)) chrome.alarms.clear(a.name);
    }
  });
}

// Listen for session results and other messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "sessionResult") {
    const result = msg.result;
    console.log('Session completed:', result);
    
    // Log the session result
    if (result.success) {
      appendLog({
        kind: "success",
        message: `Session completed: ${result.videosWatched || 1} videos watched`,
        details: `Keyword: "${result.keyword}", Watch time: ${Math.round(result.watchSeconds || 0)}s`,
        time: Date.now()
      });
    } else {
      appendLog({
        kind: "error", 
        message: "Session failed",
        details: result.error || "Unknown error",
        time: Date.now()
      });
    }
    
    sendResponse({ received: true });
  }
});

// Start the boost: initialize storage, schedule alarms, create run id
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "start") {
    startBoost(msg.keywords).then(() => sendResponse({ status: "started" }));
    return true;
  }
  if (msg.action === "startImmediate") {
    startImmediateSessions(msg.keywords).then(() =>
      sendResponse({ status: "started" })
    );
    return true;
  }
  if (msg.action === "stop") {
    stopBoost().then(() => sendResponse({ status: "stopped" }));
    return true;
  }
  if (msg.action === "generateKeywords") {
    (async () => {
      try {
        const topic = msg.topic;
        if (!topic) return sendResponse({ error: "No topic provided" });
        // Read stored apiKey (user-provided) if any
        const s = await getStore(["apiKey"]);
        const apiKey = s.apiKey || null;
        if (!apiKey) {
          return sendResponse({
            error:
              "No API key configured. Add your Gemini API key in the popup.",
          });
        }
        const keywords = await callGeminiForKeywords(topic, apiKey);
        return sendResponse({ keywords, success: true });
      } catch (err) {
        return sendResponse({ error: String(err) });
      }
    })();
    return true; // signal async response
  }
});

// Call Gemini/Generative Language API to get comma-separated keywords
async function callGeminiForKeywords(topic, apiKey) {
  // Construct a concise prompt requesting 8 short keyword phrases, comma-separated
  const prompt = `Generate 8-12 concise YouTube search keywords (comma-separated) for the topic: "${topic}". Output only the keywords separated by commas, no extra commentary.`;
  // Try the Google Generative Language endpoint (text-bison)
  const url =
    "https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText";
  const body = {
    prompt: { text: prompt },
    temperature: 0.7,
    maxOutputTokens: 128,
  };
  // first try Bearer token style
  let res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    // try with ?key= approach (api key as query param)
    const res2 = await fetch(url + `?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    res = res2;
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json();
  // Response parsing: try several fields to extract text
  let text = null;
  if (json.candidates && json.candidates[0] && json.candidates[0].content)
    text = json.candidates[0].content;
  if (
    !text &&
    json.candidates &&
    json.candidates[0] &&
    json.candidates[0].output
  )
    text = json.candidates[0].output;
  if (!text && json.output_text) text = json.output_text;
  if (!text && json.result) text = JSON.stringify(json.result);
  if (!text) throw new Error("Could not parse response");
  // Normalize and split by commas or line breaks
  let items = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Keep unique first 12
  const uniq = [...new Set(items)].slice(0, 12);
  return uniq;
}

// Start boost implementation
async function startBoost(userKeywords) {
  // Don't start if already running
  const existing = await getStore();
  if (existing.isRunning) {
    chrome.notifications.create("ytboost-already", {
      type: "basic",
      iconUrl: "icon-128.png",
      title: "YT Recommendation Booster",
      message: "A boost is already running. Stop it first to start a new one.",
    });
    return;
  }

  const startTs = Date.now();
  const runId = `run-${startTs}`;
  const keywords =
    userKeywords && userKeywords.length
      ? userKeywords.slice(0, 20)
      : CONFIG.defaultKeywords;
  // Preserve existing logs (if any) and initialize run state
  await setStore({
    isRunning: true,
    runId,
    daysCompleted: 0,
    logs: existing.logs || [],
    keywords,
    startTs,
  });
  await scheduleAlarmsForRun(runId, startTs, keywords);
  // set an end alarm after CONFIG.days days + a small buffer
  const endName = `end-${runId}`;
  chrome.alarms.create(endName, {
    when: startTs + CONFIG.days * 24 * 60 * 60 * 1000 + 60 * 1000,
  }); // +1min buffer
  // Notify user
  chrome.notifications.create(`ytboost-start-${runId}`, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "YT Recommendation Booster started",
    message: `Running a ${CONFIG.days}-day boost using ${keywords.length} keywords.`,
  });
}

// Start immediate sessions (no scheduling, trigger now)
async function startImmediateSessions(userKeywords) {
  const keywords =
    userKeywords && userKeywords.length
      ? userKeywords.slice(0, 20)
      : CONFIG.defaultKeywords;
  const runId = `immediate-${Date.now()}`;

  // Simple state tracking for immediate mode
  await setStore({
    isRunning: true,
    runId,
    keywords,
    startTs: Date.now(),
    immediateMode: true,
  });

  // Notify user
  chrome.notifications.create(`ytboost-immediate-${runId}`, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "YT Sessions Started",
    message: `Starting immediate sessions with ${keywords.length} keywords.`,
  });

  // Start first session immediately
  triggerImmediateSession(keywords, runId);
}

// Trigger an immediate session (no alarms)
async function triggerImmediateSession(keywords, runId) {
  const keyword =
    keywords[Math.floor(Math.random() * keywords.length)] ||
    CONFIG.defaultKeywords[0];

  console.log('Triggering immediate session with keyword:', keyword);

  // Create an ACTIVE tab to YouTube for better automation
  chrome.tabs.create(
    { url: "https://www.youtube.com", active: true },
    async (tab) => {
      const tabId = tab.id;
      console.log('Created YouTube tab:', tabId);
      
      try {
        // Wait for tab to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('Injecting content script...');
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        
        console.log('Content script injected, sending message...');
        // Start the session with params
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            action: "startSession",
            params: {
              keyword,
              runId,
              config: {
                maxWatchSeconds: CONFIG.maxWatchSeconds,
              },
            },
          }, (response) => {
            console.log('Message sent, response:', response);
            if (chrome.runtime.lastError) {
              console.error('Message error:', chrome.runtime.lastError);
            }
            
            // Schedule next session after this one completes
            setTimeout(() => {
              triggerImmediateSession(keywords, runId);
            }, rand(30000, 120000)); // 30 seconds to 2 minutes between sessions
          });
        }, 2000);
        
      } catch (err) {
        console.error("Session error", err);
        chrome.tabs.remove(tabId).catch(() => {});
        await appendLog({
          kind: "error",
          message: "Session failure",
          details: String(err),
          time: Date.now(),
        });
        
        // Retry after error
        setTimeout(() => {
          triggerImmediateSession(keywords, runId);
        }, 30000);
      }
    }
  );
}

// Stop the boost early
async function stopBoost() {
  const store = await getStore();
  const runId = (store.currentRun && store.currentRun.id) || store.runId;
  if (runId) cancelRunAlarms(runId);
  await setStore({
    isRunning: false,
    runId: null,
    currentRun: null,
    immediateMode: false,
  });
  chrome.notifications.create("ytboost-stopped", {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "YT Sessions stopped",
    message: "Sessions stopped by user.",
  });
}

// Alarm handler: session alarms and run end
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // session alarm names: session-<runId>-<ts>
  if (alarm.name.startsWith("session-")) {
    // Extract run id from name: session-<runId>-...
    // runId is the second segment when splitting by '-'
    // but our runId includes 'run-<ts>', so we can split differently:
    // session-<runId>-<ts> => remove prefix 'session-' and split on last '-'
    const raw = alarm.name.slice(8); // after 'session-'
    const lastDash = raw.lastIndexOf("-");
    const runId = raw.slice(0, lastDash);
    const store = await getStore();
    // If not running or runId mismatch, ignore
    if (!store.isRunning || (store.runId && store.runId !== runId)) return;
    triggerSession(alarm.name);
  } else if (alarm.name.startsWith("end-")) {
    // End of boost
    const store = await getStore();
    await setStore({ isRunning: false, currentRun: null, runId: null });
    chrome.notifications.create("ytboost-finished", {
      type: "basic",
      iconUrl: "icon-128.png",
      title: "Boost complete!",
      message: "7-day boost finished. Check your YouTube recommendations.",
    });
  }
});

// Trigger a single session: open a background tab and inject content script
async function triggerSession(alarmName) {
  const store = await getStore();
  const run = store.currentRun || {};
  const keywords = run.keywords || CONFIG.defaultKeywords;
  // choose a keyword (cycle randomly)
  const keyword =
    keywords[Math.floor(Math.random() * keywords.length)] ||
    CONFIG.defaultKeywords[0];
  // Create a non-active tab to YouTube
  chrome.tabs.create(
    { url: "https://www.youtube.com", active: false },
    async (tab) => {
      const tabId = tab.id;
      // Inject content script file then send start message
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        // Start the session with params
        chrome.tabs.sendMessage(tabId, {
          action: "startSession",
          params: {
            keyword,
            runId: run.id,
            config: {
              maxWatchSeconds: CONFIG.maxWatchSeconds,
            },
          },
        });
      } catch (err) {
        // If injection fails, log and close the tab
        console.error("Injection error", err);
        chrome.tabs.remove(tabId).catch(() => {});
        await appendLog({
          kind: "error",
          message: "Injection failure",
          details: String(err),
          time: Date.now(),
        });
      }
    }
  );
}

// Append session logs and keep trimmed
async function appendLog(entry) {
  const s = await getStore();
  const logs = s.logs || [];
  logs.unshift(entry);
  if (logs.length > CONFIG.maxLogs) logs.length = CONFIG.maxLogs;
  await setStore({ logs });
}

// Handle messages from content script (session results)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "sessionResult") {
    // msg.result contains session details, sender.tab.id has tab id
    (async () => {
      const result = msg.result || {};
      result.ts = Date.now();
      result.tabId = sender.tab && sender.tab.id;
      await appendLog(result);
      // Close tab if still open
      if (sender.tab && sender.tab.id) {
        chrome.tabs.remove(sender.tab.id).catch(() => {});
      }

      // In immediate mode, trigger another session after a brief delay
      const s = await getStore();
      if (s.immediateMode && s.isRunning && s.keywords) {
        // Wait 5-15 seconds then start another session
        setTimeout(() => {
          triggerImmediateSession(s.keywords, s.runId);
        }, Math.floor(Math.random() * 10000) + 5000); // 5-15 sec delay
      }

      // Update daysCompleted if appropriate (simple heuristic)
      let daysCompleted = s.daysCompleted || 0;
      if (s.startTs) {
        const daysPassed =
          Math.floor((Date.now() - s.startTs) / (24 * 60 * 60 * 1000)) + 1;
        daysCompleted = Math.min(daysPassed, CONFIG.days);
      }
      await setStore({ daysCompleted });
      // small notification per session (quiet)
      chrome.notifications.create(`ytboost-session-${Date.now()}`, {
        type: "basic",
        iconUrl: "icon-128.png",
        title: "YT Boost session complete",
        message: `Searched: "${result.keyword}" — watched ${Math.round(
          result.watchSeconds
        )}s`,
      });
    })();
  }
});
