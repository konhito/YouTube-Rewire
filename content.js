// Content script injected into youtube.com tabs to perform a single search->watch session.
// Listens for a message from the background to start.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// Robust selector helpers
function waitForSelector(selectors, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
      }
      if (Date.now() - start > timeout)
        return reject(new Error("Selector timeout: " + selectors.join(" | ")));
      requestAnimationFrame(check);
    })();
  });
}

// Simulate typing into an input element
async function typeSlowly(inputEl, text) {
  inputEl.focus();
  // clear existing text
  inputEl.value = "";
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  for (const ch of text) {
    inputEl.value += ch;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(rand(100, 200)); // human-like delay per char
  }
}

// Make small variation to keyword
function varyKeyword(keyword) {
  const variations = [
    (k) => `${k}`,
    (k) => `${k} 2025`,
    (k) => `beginner ${k}`,
    (k) => `${k} tutorial`,
    (k) => `${k} best`,
  ];
  const fn = variations[randInt(0, variations.length - 1)];
  return fn(keyword);
}

async function runSession({ keyword, config }) {
  try {
    const usedKeyword = varyKeyword(keyword);
    // Wait for search box
    const searchInput = await waitForSelector(
      ["input#search", 'input[name="search_query"]', "#search input"],
      8000
    );
    // Wait a bit for realistic load
    await sleep(rand(3000, 5000));
    // Type keyword
    await typeSlowly(searchInput, usedKeyword);
    // Submit search by clicking search button or Enter
    const searchBtn =
      document.querySelector("button#search-icon-legacy") ||
      document.querySelector('button[aria-label="Search"]');
    if (searchBtn) searchBtn.click();
    else {
      // press Enter
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      searchInput.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", bubbles: true })
      );
    }
    // Wait for results to populate
    await sleep(rand(2000, 4000));
    // Click first video - try several selectors
    const firstSelectors = [
      "ytd-video-renderer ytd-thumbnail a#thumbnail",
      "ytd-rich-item-renderer ytd-thumbnail a#thumbnail",
      "ytd-video-renderer #video-title",
      "ytd-rich-item-renderer #video-title",
    ];
    let clicked = false;
    for (const sel of firstSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(rand(300, 700));
        el.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // fallback: try to find first visible /watch? link
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/watch?"]')
      );
      const candidate = anchors.find(
        (a) => a.offsetWidth > 0 && a.offsetHeight > 0
      );
      if (candidate) {
        candidate.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(rand(300, 700));
        candidate.click();
        clicked = true;
      }
    }
    if (!clicked) throw new Error("No video found to click");

    // Wait for video page load (video element)
    const videoEl = await waitForSelector(["video"], 15000);
    // Small wait for player API to initialize
    await sleep(rand(1500, 3000));
    // Mute to avoid noise and try to play
    try {
      videoEl.muted = true;
      // play
      await videoEl.play();
    } catch (err) {
      // ignore play errors (autoplay policies)
    }
    // Determine duration
    let duration = videoEl.duration || 0;
    if (!isFinite(duration) || duration <= 0) duration = 60; // fallback to 60s
    const pct = rand(0.8, 1.0);
    const watchSeconds = Math.min(
      duration * pct,
      config.maxWatchSeconds || 900
    );
    // Engage: occasional scrolls and short pauses
    const halfway = Math.max(1, Math.floor(watchSeconds / 2));
    // wait until halfway, then scroll & small pause
    await sleep((halfway - 1) * 1000);
    window.scrollTo({
      top: document.body.scrollHeight / 2,
      behavior: "smooth",
    });
    await sleep(rand(1000, 2000));
    // resume watching rest
    await sleep((watchSeconds - halfway) * 1000);
    // Session finished
    return { success: true, keyword: usedKeyword, watchSeconds };
  } catch (err) {
    return { success: false, error: String(err), keyword };
  }
}

// Listen for messages to start a session
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startSession") {
    // Run and report back
    (async () => {
      const result = await runSession(msg.params);
      chrome.runtime.sendMessage({ type: "sessionResult", result });
      sendResponse({ status: "done" });
    })();
    // Keep the message channel open
    return true;
  }
});
