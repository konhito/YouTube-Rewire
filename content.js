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
    console.log('Starting session with keyword:', keyword);
    const usedKeyword = varyKeyword(keyword);
    console.log('Using varied keyword:', usedKeyword);
    
    // Wait for search box with better selectors
    const searchInput = await waitForSelector(
      ["input#search", 'input[name="search_query"]', "#search-input input", "input[placeholder*='Search']"],
      10000
    );
    console.log('Found search input:', searchInput);
    
    // Wait a bit for realistic load
    await sleep(rand(2000, 3000));
    
    // Clear and type keyword
    searchInput.focus();
    searchInput.select();
    await sleep(200);
    await typeSlowly(searchInput, usedKeyword);
    console.log('Typed keyword:', usedKeyword);
    
    // Try multiple methods to submit search
    let searchSubmitted = false;
    
    // Method 1: Click search button
    const searchButton = document.querySelector('#search-icon-legacy') || 
                        document.querySelector('button[aria-label="Search"]') ||
                        document.querySelector('#search-icon') ||
                        document.querySelector('.ytSearchboxComponentButton');
    
    if (searchButton) {
      console.log('Found search button, clicking...');
      searchButton.click();
      searchSubmitted = true;
    } else {
      // Method 2: Press Enter key
      console.log('Search button not found, using Enter key...');
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(100);
      searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      searchSubmitted = true;
    }
    
    if (!searchSubmitted) throw new Error('Could not submit search');
    console.log('Search submitted successfully');
    
    // Wait for results to populate
    await sleep(rand(4000, 6000));
    console.log('Waiting for search results...');
    
    // Get ALL videos from search results
    const allVideoLinks = await getAllVideosFromResults();
    console.log(`Found ${allVideoLinks.length} videos to watch`);
    
    if (allVideoLinks.length === 0) {
      throw new Error('No videos found in search results');
    }
    
    // Watch multiple videos (3-5 videos)
    const videosToWatch = Math.min(allVideoLinks.length, randInt(3, 5));
    let totalWatchTime = 0;
    
    for (let i = 0; i < videosToWatch; i++) {
      const videoLink = allVideoLinks[i];
      console.log(`Watching video ${i + 1}/${videosToWatch}:`, videoLink.href);
      
      // Click the video
      videoLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(rand(500, 1000));
      videoLink.click();
      
      // Wait for video page to load
      await sleep(rand(3000, 5000));
      
      const watchTime = await watchCurrentVideo(config);
      totalWatchTime += watchTime;
      
      // Go back to search results (except for last video)
      if (i < videosToWatch - 1) {
        window.history.back();
        await sleep(rand(2000, 3000));
      }
    }
    
    return { success: true, keyword: usedKeyword, watchSeconds: totalWatchTime, videosWatched: videosToWatch };
    
  } catch (err) {
    console.error('Session error:', err);
    return { success: false, error: String(err), keyword };
  }
}

// Get all video links from search results page
async function getAllVideosFromResults() {
  const videoLinks = [];
  const selectors = [
    'ytd-video-renderer h3 a',
    'ytd-video-renderer #video-title',
    'ytd-shorts-lockup-view-model a',
    'ytd-reel-item-renderer a',
    'a[href*="/watch?v="]',
    'a[href*="/shorts/"]'
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const href = el.href;
      if (href && (href.includes('/watch?v=') || href.includes('/shorts/')) &&
          el.offsetWidth > 0 && el.offsetHeight > 0) {
        // Avoid duplicates
        if (!videoLinks.find(link => link.href === href)) {
          videoLinks.push(el);
        }
      }
    }
  }
  
  // Shuffle for variety
  return videoLinks.sort(() => Math.random() - 0.5).slice(0, 10);
}

// Watch current video page
async function watchCurrentVideo(config) {
  try {
    console.log('Loading video page...');
    
    // Look for video element
    const videoEl = await waitForSelector(["video"], 8000);
    console.log('Found video element:', videoEl);
    
    // Try to play and mute
    try {
      videoEl.muted = true;
      await videoEl.play();
      console.log('Video playing');
    } catch (err) {
      console.log('Play error (autoplay policy):', err.message);
    }
    
    // Determine watch time
    let duration = videoEl.duration || 0;
    if (!isFinite(duration) || duration <= 0) duration = 30; // fallback
    const watchSeconds = Math.min(duration * rand(0.3, 0.8), config.maxWatchSeconds || 180);
    console.log(`Watching for ${watchSeconds} seconds`);
    
    // Engage: scroll and interact
    const quarterTime = watchSeconds / 4;
    await sleep(quarterTime * 1000);
    window.scrollTo({ top: 200, behavior: 'smooth' });
    await sleep(quarterTime * 1000);
    window.scrollTo({ top: 400, behavior: 'smooth' });
    await sleep(quarterTime * 1000);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(quarterTime * 1000);
    
    return watchSeconds;
    
  } catch (videoError) {
    console.log('Video element not found, but staying on page...');
    await sleep(rand(10000, 20000));
    return 15;
  }
}

// Listen for messages to start a session
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('Content script received message:', msg);
  
  if (msg.action === "startSession") {
    // Run and report back
    (async () => {
      console.log('Starting session with params:', msg.params);
      
      // Wait for page to be ready
      if (document.readyState !== 'complete') {
        console.log('Waiting for page to load...');
        await new Promise(resolve => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            window.addEventListener('load', resolve);
          }
        });
      }
      
      console.log('Page ready, starting session...');
      const result = await runSession(msg.params);
      console.log('Session result:', result);
      
      chrome.runtime.sendMessage({ type: "sessionResult", result });
      sendResponse({ status: "done" });
    })();
    // Keep the message channel open
    return true;
  }
});

// Also add a ready check on script load
console.log('Content script loaded on:', window.location.href);
