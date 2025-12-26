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
    const videosToWatch = Math.min(allVideoLinks.length, randInt(2, 4));
    let totalWatchTime = 0;
    let successfulWatches = 0;
    
    for (let i = 0; i < videosToWatch; i++) {
      const videoLink = allVideoLinks[i];
      console.log(`Watching video ${i + 1}/${videosToWatch}:`, videoLink.href);
      
      try {
        // Click the video
        videoLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(rand(500, 1000));
        videoLink.click();
        
        // Wait for video page to load and check if we're on a video page
        await sleep(rand(2000, 4000));
        
        // Verify we're on a video/shorts page
        if (!window.location.href.includes('/watch') && !window.location.href.includes('/shorts/')) {
          console.log('Not on video page, skipping...');
          continue;
        }
        
        const watchTime = await watchCurrentVideo(config);
        totalWatchTime += watchTime;
        successfulWatches++;
        
        console.log(`Video ${i + 1} completed. Watch time: ${watchTime}s`);
        
        // Go back to search results (except for last video)
        if (i < videosToWatch - 1) {
          const isCurrentlyOnShorts = window.location.href.includes('/shorts/');
          
          if (isCurrentlyOnShorts) {
            console.log('On shorts page, using search button to return...');
            
            // Click search button to go back to search
            const searchButton = document.querySelector('#search-icon-legacy') || 
                                document.querySelector('button[aria-label="Search"]') ||
                                document.querySelector('#search-icon') ||
                                document.querySelector('.ytSearchboxComponentButton');
            
            if (searchButton) {
              console.log('Found search button, clicking...');
              searchButton.click();
              await sleep(rand(2000, 3000));
            } else {
              // Fallback: navigate to search URL directly
              console.log('Search button not found, navigating to search URL...');
              const searchQuery = usedKeyword.replace(/\s+/g, '+');
              window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
              await sleep(rand(3000, 4000));
            }
            
          } else {
            console.log('Going back to search results...');
            window.history.back();
            await sleep(rand(2000, 4000));
          }
          
          // Verify we're back on search results
          let backAttempts = 0;
          while (!window.location.href.includes('/results') && backAttempts < 3) {
            console.log('Not back at search results, trying direct navigation...');
            const searchQuery = usedKeyword.replace(/\s+/g, '+');
            window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
            await sleep(3000);
            backAttempts++;
          }
          
          if (!window.location.href.includes('/results')) {
            console.log('Could not return to search results, ending session');
            break;
          }
        }
        
      } catch (videoError) {
        console.log(`Error watching video ${i + 1}:`, videoError);
        // Try to go back and continue with next video
        if (i < videosToWatch - 1) {
          try {
            window.history.back();
            await sleep(2000);
          } catch (backError) {
            console.log('Could not go back, ending session');
            break;
          }
        }
      }
    }
    
    console.log(`Session completed. Videos watched: ${successfulWatches}/${videosToWatch}, Total time: ${totalWatchTime}s`);
    return { 
      success: true, 
      keyword: usedKeyword, 
      watchSeconds: totalWatchTime, 
      videosWatched: successfulWatches,
      videosAttempted: videosToWatch
    };
    
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
    const currentUrl = window.location.href;
    const isShorts = currentUrl.includes('/shorts/');
    console.log('Video type:', isShorts ? 'Shorts' : 'Regular Video');
    
    if (isShorts) {
      // Handle YouTube Shorts differently - watch multiple shorts by scrolling
      console.log('Handling YouTube Shorts...');
      
      const shortsToWatch = randInt(2, 4); // Watch 2-4 shorts
      console.log(`Will watch ${shortsToWatch} shorts by scrolling`);
      
      for (let shortIndex = 0; shortIndex < shortsToWatch; shortIndex++) {
        const watchTime = rand(5, 15); // Each short 5-15 seconds
        console.log(`Watching short ${shortIndex + 1}/${shortsToWatch} for ${watchTime}s`);
        
        // Watch current short
        await sleep(watchTime * 1000);
        
        // Scroll down to next short (except for last one)
        if (shortIndex < shortsToWatch - 1) {
          console.log('Scrolling to next short...');
          window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
          await sleep(rand(1000, 2000)); // Wait for next short to load
        }
      }
      
      console.log('Finished watching shorts, returning to search');
      return shortsToWatch * 10; // Return total estimated watch time
      
    } else {
      // Handle regular videos - existing logic
      
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
    
    // Wait for video to load metadata
    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) resolve();
      else videoEl.addEventListener('loadedmetadata', resolve);
    });
    
    // Determine watch strategy based on video duration
    let duration = videoEl.duration || 0;
    if (!isFinite(duration) || duration <= 0) duration = 60; // fallback
    
    let watchSeconds;
    if (duration <= 30) {
      // Very short videos (30s or less) - watch completely
      watchSeconds = duration;
      console.log(`Short video (${duration}s) - watching completely`);
    } else if (duration <= 180) {
      // Short videos (under 3 minutes) - watch 80-100%
      watchSeconds = duration * rand(0.8, 1.0);
      console.log(`Medium video (${duration}s) - watching ${watchSeconds}s`);
    } else {
      // Longer videos - watch 30-60% or max 5 minutes
      watchSeconds = Math.min(duration * rand(0.3, 0.6), 300);
      console.log(`Long video (${duration}s) - watching ${watchSeconds}s`);
    }
    
    // Watch with real-time monitoring
    const startTime = Date.now();
    const targetEndTime = startTime + (watchSeconds * 1000);
    let lastCurrentTime = 0;
    
    while (Date.now() < targetEndTime) {
      // Check if video ended
      if (videoEl.ended) {
        console.log('Video ended naturally');
        await sleep(1000); // Brief pause before moving on
        break;
      }
      
      // Check if video is stuck (not progressing)
      if (Math.abs(videoEl.currentTime - lastCurrentTime) < 0.1) {
        console.log('Video appears stuck, continuing...');
      }
      lastCurrentTime = videoEl.currentTime;
      
      // Realistic engagement during watching
      const elapsed = (Date.now() - startTime) / 1000;
      const progress = elapsed / watchSeconds;
      
      if (progress > 0.25 && progress < 0.3) {
        window.scrollTo({ top: 200, behavior: 'smooth' });
      } else if (progress > 0.5 && progress < 0.55) {
        window.scrollTo({ top: 400, behavior: 'smooth' });
      } else if (progress > 0.75 && progress < 0.8) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      
      // Check every second
      await sleep(1000);
    }
    
    const actualWatchTime = Math.min((Date.now() - startTime) / 1000, duration);
    console.log(`Finished watching. Planned: ${watchSeconds}s, Actual: ${actualWatchTime}s`);
    
    return actualWatchTime;
    } // End of else block for regular videos
    
  } catch (videoError) {
    console.log('Video element not found, but staying on page...');
    await sleep(rand(5000, 10000)); // Shorter wait if no video
    return 8;
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
