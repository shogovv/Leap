let currentLang = "ja";
let currentMood = "day";
let settingsLoaded = { moodMode: "auto", view: "list", lang: "ja" };

function t(key){
  return (MESSAGES[currentLang] && MESSAGES[currentLang][key])
    || (MESSAGES.ja && MESSAGES.ja[key])
    || key;
}

function saveSettings(){
  try { chrome.storage.local.set(settingsLoaded); } catch {}
}

function isBookmarklet(url){ return typeof url === "string" && url.trim().toLowerCase().startsWith("javascript:"); }
function extractDomain(url){ try { return new URL(url).hostname; } catch { return ""; } }
function faviconUrl(pageUrl){
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "32");
  return u.toString();
}
function relativeTime(ts){
  if(!ts) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if(diffSec < 60) return "たった今";
  const diffMin = Math.floor(diffSec / 60);
  if(diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.floor(diffMin / 60);
  if(diffHour < 24) return `${diffHour}時間前`;
  return `${Math.floor(diffHour / 24)}日前`;
}

// folder name -> emoji, best-effort only; falls back to a generic folder icon
const ICON_GUESS = [
  [/仕事|業務|work/i, "💼"], [/開発|エンジニア|dev|engineering|code/i, "💻"],
  [/デザイン|design/i, "🎨"], [/学習|勉強|study|learn/i, "📚"],
  [/ニュース|news/i, "📰"], [/プライベート|private|personal/i, "🏠"],
  [/お金|経理|finance|money/i, "💰"], [/旅行|travel/i, "✈️"],
  [/買い物|ショッピング|shop/i, "🛍️"], [/グルメ|レシピ|food/i, "🍽️"],
];
function guessIcon(name){
  for(const [re, emoji] of ICON_GUESS){ if(re.test(name)) return emoji; }
  return "📁";
}

const ACCENT_CYCLE = ["var(--accent1)","var(--accent2)","var(--accent3)","var(--accent4)","var(--accent5)","var(--accent6)"];

// reads the real Bookmarks Bar (id "1") — direct child bookmarks become a "Bookmarks Bar"
// pseudo-folder (nameKey, translated at render time), direct child folders each become
// their own section (their titles are the user's own data, never translated); nested
// sub-folders inside those aren't recursed into for now
async function loadFolders(){
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const bar = (root.children || []).find(n => n.id === "1") || (root.children || [])[0];
  if(!bar || !bar.children) return [];

  const looseItems = [];
  const folders = [];
  let colorIdx = 0;

  for(const node of bar.children){
    if(node.url){
      if(isBookmarklet(node.url)) continue;
      looseItems.push({ label: node.title || node.url, url: node.url, domain: extractDomain(node.url) });
    } else if(node.children){
      const items = node.children
        .filter(c => c.url && !isBookmarklet(c.url))
        .map(c => ({ label: c.title || c.url, url: c.url, domain: extractDomain(c.url) }));
      folders.push({
        name: node.title || null,
        nameKey: node.title ? null : "untitledFolder",
        icon: guessIcon(node.title || ""),
        tape: ACCENT_CYCLE[colorIdx % ACCENT_CYCLE.length],
        items,
      });
      colorIdx++;
    }
  }

  const sections = [];
  if(looseItems.length){
    sections.push({ nameKey:"bookmarksBar", icon:"📌", tape:"var(--accent-recent)", items: looseItems });
  }
  sections.push(...folders);
  return sections;
}

// shown when the search box is empty — NOT a pool size cap. chrome.tabs.query() and
// filtering plain objects are cheap even at hundreds of tabs; what's actually expensive
// is rendering that many DOM rows on every keystroke. So the full pool (no cap) is kept
// for matching against, and only this many render when there's nothing to search for —
// see the `capWhenEmpty` handling in render().
const OPEN_TABS_DEFAULT_DISPLAY = 15;
const CLOSED_TABS_DEFAULT_DISPLAY = 15;

// tabs that are currently open, most-recently-active first — NOT browsing history.
// excludes this new-tab page itself and any other blank new-tab pages (those are also
// chrome-extension://<us>/newtab.html, since we're the override). Clicking one switches
// to it via chrome.tabs.update() instead of navigating, since it's already open — see
// activate() below
async function loadOpenTabsSection(){
  let currentTabId = null;
  try {
    const cur = await chrome.tabs.getCurrent();
    currentTabId = cur && cur.id;
  } catch {}

  const tabs = await chrome.tabs.query({});
  const items = tabs
    .filter(tab => tab.id !== currentTabId && tab.url && !isBookmarklet(tab.url)
      && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://"))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map(tab => ({
      label: tab.title || tab.url,
      url: tab.url,
      domain: extractDomain(tab.url),
      meta: relativeTime(tab.lastAccessed),
      tabId: tab.id,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl || "",
    }));

  // temporary diagnostic — check this tab's DevTools console (right-click → inspect) if
  // the open-tabs section is unexpectedly empty or short
  console.info(`newtab: open tabs — queried ${tabs.length}, currentTabId=${currentTabId}, kept ${items.length}`);

  if(!items.length) return null;
  return { nameKey:"openTabs", icon:"🕒", tape:"var(--accent-recent)", items, capWhenEmpty: OPEN_TABS_DEFAULT_DISPLAY };
}

// tabs that were closed recently — chrome.sessions, a different API from chrome.tabs.
// Chrome caps this at 25 entries itself (MAX_SESSION_RESULTS), so there's no pool-size
// concern here like with open tabs. Clicking one restores it (session + history intact)
// via chrome.sessions.restore() rather than just navigating to its bare URL.
async function loadClosedTabsSection(){
  if(!chrome.sessions || !chrome.sessions.getRecentlyClosed) return null;
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  const items = sessions
    .filter(s => s.tab && s.tab.url && !isBookmarklet(s.tab.url))
    .map(s => ({
      label: s.tab.title || s.tab.url,
      url: s.tab.url,
      domain: extractDomain(s.tab.url),
      meta: relativeTime((s.lastModified || 0) * 1000), // lastModified is seconds since epoch
      sessionId: s.tab.sessionId,
      favIconUrl: s.tab.favIconUrl || "",
    }));

  if(!items.length) return null;
  return { nameKey:"closedTabs", icon:"🗑️", tape:"var(--accent-recent)", items, capWhenEmpty: CLOSED_TABS_DEFAULT_DISPLAY };
}

let sections = [];
let currentView = "list";
let activeHints = {};
let selectedIndex = -1;
const HINT_POOL = ["g","j","l","s","r","u","i","w","q","c","v","x","z"];
const HINT_THRESHOLD = 9;

const gridEl = document.getElementById("grid");
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("emptyState");
const queryPill = document.getElementById("queryPill");
const queryInput = document.getElementById("queryInput");
const matchCountEl = document.getElementById("matchCount");
const greetingEl = document.getElementById("greeting");
const starsEl = document.getElementById("stars");
const tooltipEl = document.getElementById("tooltip");


function moodForHour(h){
  if(h>=5 && h<8) return "dawn";
  if(h>=8 && h<17) return "day";
  if(h>=17 && h<20) return "dusk";
  if(h>=20 || h<0) return "night";
  return "latenight"; // 0-5
}
const MOOD_ORDER = ["dawn","day","dusk","night","latenight"];
const MOOD_LABEL_KEY = { dawn:"moodDawn", day:"moodDay", dusk:"moodDusk", night:"moodNight", latenight:"moodLatenight" };

function setMood(mood){
  currentMood = mood;
  document.body.setAttribute("data-mood", mood);
  const pool = (MOODS[mood].greetings[currentLang]) || MOODS[mood].greetings.ja;
  greetingEl.textContent = pool[Math.floor(Math.random() * pool.length)];
  updateMoodRowsUI();
}
function buildStars(){
  starsEl.innerHTML = "";
  for(let i = 0; i < 50; i++){
    const s = document.createElement("div");
    s.className = "star";
    s.style.left = Math.random() * 100 + "%";
    s.style.top = Math.random() * 70 + "%";
    s.style.animationDelay = (Math.random() * 3) + "s";
    starsEl.appendChild(s);
  }
}
buildStars();

function escHtml(s){ return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function escAttr(s){ return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// full label + URL, read by the fast custom tooltip (see below) — not the native title=
// attribute, which took Chrome ~1-1.5s to surface and felt sluggish
function itemTooltipAttr(i){ return `data-tooltip="${escAttr(i.label)}\n${escAttr(i.url)}"`; }

// query splits on whitespace into AND tokens. a token can be satisfied by the item's
// label, its URL, OR its folder's name — so typing just a folder name (one token) matches
// every item in it, and adding more tokens narrows within that folder (or narrows a plain
// multi-word search generally, folder or not)
function tokenize(q){ return q.trim().split(/\s+/).filter(Boolean).map(t => t.toLowerCase()); }
function tokenMatches(item, folderName, token){
  return item.label.toLowerCase().includes(token)
    || item.url.toLowerCase().includes(token)
    || folderName.toLowerCase().includes(token);
}
function matches(item, folderName, tokens){
  return tokens.every(t => tokenMatches(item, folderName, t));
}
function highlightTokens(text, tokens){
  const safe = escHtml(text);
  if(!tokens.length) return safe;
  const re = new RegExp(`(${tokens.map(t => escRe(escHtml(t))).join("|")})`, "gi");
  return safe.replace(re, "<mark>$1</mark>");
}
function shortUrl(url){ return url.replace(/^https?:\/\//, ""); }

// bookmarks navigate the current tab (no target=_blank); open tabs carry data-tab-id/
// data-window-id and get switched to instead; closed tabs carry data-session-id and get
// restored instead — see activate()
function tabAttrs(i){
  if(i.sessionId != null) return `data-session-id="${escAttr(i.sessionId)}"`;
  if(i.tabId != null) return `data-tab-id="${i.tabId}" data-window-id="${i.windowId}"`;
  return "";
}

// pseudo-sections (bookmarks bar / open tabs / closed tabs) carry a nameKey resolved
// through t() so they follow the language switch; real bookmark folders keep the user's
// own title untouched regardless of language
function sectionName(f){ return f.nameKey ? t(f.nameKey) : f.name; }

// sections with capWhenEmpty (recent tabs) only render their top N when there's nothing
// to search for; once a query narrows things down, matching runs over the full pool
function visibleItems(f, tokens){
  if(tokens.length === 0 && f.capWhenEmpty) return f.items.slice(0, f.capWhenEmpty);
  return f.items.filter(i=>matches(i, sectionName(f), tokens));
}

function render(){
  hideTooltip(); // the hovered element (if any) is about to be destroyed and rebuilt
  const tokens = tokenize(queryInput.value);
  gridEl.innerHTML = "";
  let anyVisible = false;
  sections.forEach(f=>{
    const visItems = visibleItems(f, tokens);
    const widget = document.createElement("div");
    widget.className = "widget" + (visItems.length===0 ? " hidden" : "");
    widget.style.setProperty("--tape", f.tape);
    if(visItems.length) anyVisible = true;
    widget.innerHTML = `
      <div class="widget-head"><span>${f.icon}</span><span>${highlightTokens(sectionName(f), tokens)}</span><span class="count">${visItems.length}</span></div>
      <div class="bm-list">
        ${visItems.map(i=>`
          <a class="bm" href="${i.url}" ${tabAttrs(i)} ${itemTooltipAttr(i)} data-id="${i.id}">
            <span class="icon"><img src="${i.favIconUrl || faviconUrl(i.url)}"></span>
            <span class="label">${highlightTokens(i.label, tokens)}</span>
          </a>`).join("")}
      </div>`;
    gridEl.appendChild(widget);
  });

  listEl.innerHTML = "";
  sections.forEach(f=>{
    const visItems = visibleItems(f, tokens);
    const row = document.createElement("div");
    row.className = "folder-row" + (visItems.length===0 ? " hidden" : "");
    row.style.setProperty("--tape", f.tape);
    row.innerHTML = `
      <div class="folder-row-head"><span>${f.icon}</span><span>${highlightTokens(sectionName(f), tokens)}</span><span class="count">${visItems.length}</span></div>
      <div class="list-items">
        ${visItems.map(i=>`
          <a class="list-item" href="${i.url}" ${tabAttrs(i)} ${itemTooltipAttr(i)} data-id="${i.id}">
            <span class="icon"><img src="${i.favIconUrl || faviconUrl(i.url)}"></span>
            <span class="label">${highlightTokens(i.label, tokens)}</span>
            <span class="domain">${i.meta ? escHtml(i.meta) : highlightTokens(shortUrl(i.url), tokens)}</span>
          </a>`).join("")}
      </div>`;
    listEl.appendChild(row);
  });

  emptyEl.textContent = t("emptyState");
  emptyEl.classList.toggle("show", !anyVisible);
  applyHints();
}

// bookmarks: navigate this tab. open tabs (data-tab-id present): switch to them instead,
// via chrome.tabs.update()/chrome.windows.update(), rather than opening a duplicate.
// closed tabs (data-session-id present): restore them via chrome.sessions.restore(),
// which brings back their navigation history too, not just a fresh load of the bare URL.
function activate(a){
  const sessionId = a.dataset.sessionId;
  const tabId = a.dataset.tabId;
  if(sessionId){
    chrome.sessions.restore(sessionId);
  } else if(tabId){
    chrome.tabs.update(Number(tabId), { active: true });
    if(a.dataset.windowId) chrome.windows.update(Number(a.dataset.windowId), { focused: true });
  } else {
    location.href = a.getAttribute("href");
  }
}

const CONFIRM_DELAY_MS = 160; // long enough to see the flash, short enough not to feel laggy

// plays the "confirmed" flash on the chosen item, then actually navigates/switches a beat
// later — every activation path (Enter, Ctrl+letter, hint click, mouse click) goes through
// this single place so the feedback is consistent everywhere
function confirmActivate(a){
  a.classList.add("confirming");
  clearQueryInput(); // silent — no re-render, so nothing flashes back to the full list first
  setTimeout(()=>activate(a), CONFIRM_DELAY_MS);
}

function getVisibleAnchors(){
  const activeContainer = currentView === "grid" ? gridEl : listEl;
  return Array.from(activeContainer.querySelectorAll("a")).filter(a => a.offsetParent !== null);
}

// Ctrl+P/Ctrl+N move this cursor through the currently-filtered results (not text-cursor
// lines — this is a single-line field, so those native bindings are a no-op here anyway,
// leaving the keys free); Enter activates whichever one is selected
function highlightSelection(anchors){
  anchors.forEach((a, i) => a.classList.toggle("selected", i === selectedIndex));
  const el = anchors[selectedIndex];
  if(el) el.scrollIntoView({ block: "nearest" });
}
function moveSelection(delta){
  const anchors = getVisibleAnchors();
  if(!anchors.length) return;
  selectedIndex = Math.max(0, Math.min(anchors.length - 1, selectedIndex + delta));
  highlightSelection(anchors);
}

function applyHints(){
  activeHints = {};
  document.querySelectorAll(".hint").forEach(h=>h.remove());
  const query = queryInput.value;
  const visibleAnchors = getVisibleAnchors();

  selectedIndex = visibleAnchors.length ? 0 : -1;
  highlightSelection(visibleAnchors);

  if(query && visibleAnchors.length > 0 && visibleAnchors.length <= HINT_THRESHOLD){
    visibleAnchors.forEach((a, idx)=>{
      const letter = HINT_POOL[idx];
      if(!letter) return;
      const badge = document.createElement("span");
      badge.className = "hint";
      badge.textContent = letter.toUpperCase();
      badge.addEventListener("click", (e)=>{
        e.preventDefault(); e.stopPropagation();
        confirmActivate(a);
      });
      a.appendChild(badge);
      activeHints[letter] = a;
    });
  }
  matchCountEl.textContent = visibleAnchors.length + t("matchCountSuffix") +
    (query && visibleAnchors.length<=HINT_THRESHOLD && visibleAnchors.length>0 ? t("matchCountHint") : "");
}

function updatePillVisibility(){
  queryPill.classList.toggle("show", queryInput.value.length>0);
  queryInput.size = Math.max(1, queryInput.value.length);
}
// clears the query without rendering — use this right before leaving the page (navigating
// away or switching tabs), so the full list doesn't flash back into view while we're still
// visible for that one frame. render() then only happens once we're actually back (focus).
function clearQueryInput(){ queryInput.value = ""; updatePillVisibility(); }
function resetQuery(){ clearQueryInput(); render(); }

// Chrome gives no reliable way to veto/cancel IME composition from JS (blur+refocus was
// tried and it scrambles the composition instead of cancelling it) — so we let IME work
// normally and just avoid filtering on the not-yet-committed in-progress text: input
// events fire per keystroke during composition too, with isComposing:true on each one,
// so skip those and only search once the reading is actually committed.
queryInput.addEventListener("input", (e)=>{
  if(e.isComposing) return;
  updatePillVisibility();
  render();
});
queryInput.addEventListener("compositionend", ()=>{ updatePillVisibility(); render(); });
queryInput.addEventListener("keydown", (e)=>{
  if(e.key === "Escape"){ e.preventDefault(); resetQuery(); return; }
  if(e.key === "Enter"){
    e.preventDefault();
    const anchors = getVisibleAnchors();
    if(anchors[selectedIndex]) confirmActivate(anchors[selectedIndex]);
    return;
  }
  if(e.ctrlKey && !e.metaKey && !e.altKey){
    const k = e.key.toLowerCase();
    if(k === "p"){ e.preventDefault(); moveSelection(-1); return; }
    if(k === "n"){ e.preventDefault(); moveSelection(1); return; }
    if(activeHints[k]){ e.preventDefault(); confirmActivate(activeHints[k]); }
  }
});
document.addEventListener("click", (e)=>{
  if(e.target.closest(".modal-backdrop")) return;
  setTimeout(()=>queryInput.focus(), 0);
});
// capture phase so this runs before queryInput's own Escape (clear search) handler —
// closing the settings modal takes priority when it's open, regardless of what has focus
document.addEventListener("keydown", (e)=>{
  if(e.key === "Escape" && isModalOpen()){
    e.preventDefault(); e.stopPropagation();
    closeModal();
  }
}, true);
window.addEventListener("focus", ()=>{ queryInput.focus(); render(); });
queryInput.focus();

// mouse clicks get the same confirm flash + activate() routing as keyboard activation
// (bookmarks navigate here, already-open tabs switch to instead of opening a duplicate)
function handleContainerClick(e){
  const a = e.target.closest("a");
  if(!a) return;
  if(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let modifier-clicks open normally
  e.preventDefault();
  hideTooltip();
  confirmActivate(a);
}
gridEl.addEventListener("click", handleContainerClick);
listEl.addEventListener("click", handleContainerClick);

// fast custom hover tooltip (native title= took Chrome ~1-1.5s to show, felt sluggish)
const TOOLTIP_DELAY_MS = 250;
let tooltipTimer = null;
let tooltipTarget = null;

// body has `zoom` set (see its rule) so this element inherits it too, which makes plain
// position:fixed top/left assignments render ~zoom× further than the px value given —
// getBoundingClientRect()/window.innerWidth/innerHeight report true visual px regardless,
// but offsetWidth/offsetHeight on THIS (zoomed) element are pre-zoom local units. So:
// convert local->visual by multiplying zoom, and visual->local (for what we assign) by
// dividing by it — confirmed against real measurements, not just inferred from docs.
function showTooltip(a){
  const text = a.dataset.tooltip;
  if(!text) return;
  tooltipEl.textContent = text;
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const rect = a.getBoundingClientRect();
  const place = (visualLeft, visualTop) => {
    tooltipEl.style.left = (visualLeft / zoom) + "px";
    tooltipEl.style.top = (visualTop / zoom) + "px";
  };
  place(rect.left, rect.bottom + 6);
  tooltipEl.classList.add("show");
  requestAnimationFrame(()=>{
    // clamp after it has a real size, so it never runs off the right/bottom edge
    const visualW = tooltipEl.offsetWidth * zoom;
    const visualH = tooltipEl.offsetHeight * zoom;
    let visualLeft = rect.left;
    let visualTop = rect.bottom + 6;
    const maxVisualLeft = window.innerWidth - visualW - 8;
    if(visualLeft > maxVisualLeft) visualLeft = Math.max(8, maxVisualLeft);
    if(visualTop + visualH > window.innerHeight){
      visualTop = rect.top - visualH - 6;
    }
    place(visualLeft, visualTop);
  });
}
function hideTooltip(){
  clearTimeout(tooltipTimer);
  tooltipTarget = null;
  tooltipEl.classList.remove("show");
}
// delegated at document level so it covers bookmark/tab rows AND the header buttons
// (mood picker, grid/list toggle, edit-bookmarks) with one set of listeners
function handleTooltipMouseOver(e){
  const a = e.target.closest("[data-tooltip]");
  if(!a || a === tooltipTarget) return;
  clearTimeout(tooltipTimer);
  tooltipTarget = a;
  tooltipTimer = setTimeout(()=>showTooltip(a), TOOLTIP_DELAY_MS);
}
function handleTooltipMouseOut(e){
  const a = e.target.closest("[data-tooltip]");
  if(!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
  hideTooltip();
}
document.addEventListener("mouseover", handleTooltipMouseOver);
document.addEventListener("mouseout", handleTooltipMouseOut);

document.getElementById("btnGrid").addEventListener("click", ()=>{
  currentView = "grid";
  settingsLoaded.view = "grid"; saveSettings();
  document.getElementById("btnGrid").classList.add("active");
  document.getElementById("btnList").classList.remove("active");
  gridEl.classList.add("active"); listEl.classList.remove("active");
  hideTooltip();
  applyHints();
});
document.getElementById("btnList").addEventListener("click", ()=>{
  currentView = "list";
  settingsLoaded.view = "list"; saveSettings();
  document.getElementById("btnList").classList.add("active");
  document.getElementById("btnGrid").classList.remove("active");
  listEl.classList.add("active"); gridEl.classList.remove("active");
  hideTooltip();
  applyHints();
});

// a plain <a href="chrome://bookmarks/"> is blocked by Chrome when the click is
// page-initiated — chrome.tabs.create() is the extension-privileged way to open it,
// and this page gets that API for free since it's the new-tab override itself
document.getElementById("btnEditBookmarks").addEventListener("click", (e)=>{
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://bookmarks/" });
  closeModal();
});

// ===== settings modal =====
const settingsBackdrop = document.getElementById("settingsBackdrop");
const moodListEl = document.getElementById("moodList");
const helpListEl = document.getElementById("helpList");

function isModalOpen(){ return settingsBackdrop.classList.contains("show"); }
function openModal(){ renderSettingsPanel(); settingsBackdrop.classList.add("show"); }
function closeModal(){ settingsBackdrop.classList.remove("show"); queryInput.focus(); }

function updateMoodRowsUI(){
  moodListEl.querySelectorAll(".mood-row").forEach(row=>{
    const active = settingsLoaded.moodMode === "auto"
      ? row.dataset.mood === "auto"
      : row.dataset.mood === currentMood && settingsLoaded.moodMode !== "auto";
    row.classList.toggle("active", active);
  });
}

const HELP_ROWS = [
  ["helpNarrow","helpNarrowKey"], ["helpAnd","helpAndKey"], ["helpMove","helpMoveKey"],
  ["helpOpen","helpOpenKey"], ["helpJump","helpJumpKey"], ["helpClear","helpClearKey"],
];

// rebuilds every translatable string inside the modal — called on open and on language
// switch, cheap enough (a dozen small elements) to just redo in full each time
function renderSettingsPanel(){
  document.getElementById("settingsTitle").textContent = "⚙ " + t("settingsTitle");
  document.getElementById("viewLabel").textContent = t("viewLabel");
  document.getElementById("btnGrid").textContent = t("viewGrid");
  document.getElementById("btnList").textContent = t("viewList");
  document.getElementById("btnGrid").classList.toggle("active", currentView === "grid");
  document.getElementById("btnList").classList.toggle("active", currentView === "list");

  document.getElementById("moodLabel").textContent = t("moodLabel");
  moodListEl.innerHTML = "";
  const autoRow = document.createElement("button");
  autoRow.className = "mood-row";
  autoRow.dataset.mood = "auto";
  autoRow.innerHTML = `<span class="dot"></span>${t("moodAuto")}`;
  autoRow.addEventListener("click", ()=>{
    settingsLoaded.moodMode = "auto";
    saveSettings();
    setMood(moodForHour(new Date().getHours()));
  });
  moodListEl.appendChild(autoRow);
  MOOD_ORDER.forEach(m=>{
    const row = document.createElement("button");
    row.className = "mood-row";
    row.dataset.mood = m;
    row.innerHTML = `<span class="dot"></span>${t(MOOD_LABEL_KEY[m])}`;
    row.addEventListener("click", ()=>{
      settingsLoaded.moodMode = m;
      saveSettings();
      setMood(m);
    });
    moodListEl.appendChild(row);
  });
  updateMoodRowsUI();

  document.getElementById("langLabel").textContent = t("langLabel");
  document.getElementById("btnLangJa").classList.toggle("active", currentLang === "ja");
  document.getElementById("btnLangEn").classList.toggle("active", currentLang === "en");

  document.getElementById("editBookmarksLabel").textContent = t("editBookmarks");

  document.getElementById("helpLabel").textContent = t("helpLabel");
  helpListEl.innerHTML = "";
  HELP_ROWS.forEach(([descKey, keyKey])=>{
    const row = document.createElement("div");
    row.className = "help-row";
    row.innerHTML = `<span class="desc">${t(descKey)}</span><span class="kbd">${t(keyKey)}</span>`;
    helpListEl.appendChild(row);
  });

  document.getElementById("aboutLabel").textContent = t("aboutLabel");
  document.getElementById("aboutText").textContent = t("aboutText");
  document.getElementById("aboutVersion").textContent = "v" + chrome.runtime.getManifest().version;

  document.getElementById("aiLabel").textContent = t("aiLabel");
  document.getElementById("aiHint").textContent = t("aiHint");
  document.getElementById("aiPromptText").value = t("aiPrompt");
  document.getElementById("btnCopyPrompt").textContent = t("copyButton");
}

function switchLanguage(lang){
  if(currentLang === lang) return;
  currentLang = lang;
  settingsLoaded.lang = lang;
  saveSettings();
  setMood(currentMood); // re-roll the greeting so it matches the new language too
  render();
  renderSettingsPanel();
}

document.getElementById("btnSettings").addEventListener("click", ()=>{ hideTooltip(); openModal(); });
document.getElementById("settingsClose").addEventListener("click", closeModal);
settingsBackdrop.addEventListener("click", (e)=>{ if(e.target === settingsBackdrop) closeModal(); });
document.getElementById("btnLangJa").addEventListener("click", ()=>switchLanguage("ja"));
document.getElementById("btnLangEn").addEventListener("click", ()=>switchLanguage("en"));
document.getElementById("btnCopyPrompt").addEventListener("click", async ()=>{
  const btn = document.getElementById("btnCopyPrompt");
  try {
    await navigator.clipboard.writeText(t("aiPrompt"));
    btn.textContent = t("copyButtonDone");
    setTimeout(()=>{ btn.textContent = t("copyButton"); }, 1500);
  } catch(err){ console.error("newtab: clipboard copy failed", err); }
});

function tick(){
  const now = new Date();
  const locale = currentLang === "en" ? "en-US" : "ja-JP";
  document.getElementById("time").textContent = now.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'});
  document.getElementById("date").textContent = now.toLocaleDateString(locale,{year:'numeric',month:'long',day:'numeric',weekday:'long'});
}
tick(); setInterval(tick,1000*30);

async function init(){
  // load persisted settings first — the language affects loadFolders()'s "untitled
  // folder" fallback text, and moodMode decides whether we even call moodForHour()
  try {
    const stored = await chrome.storage.local.get(["moodMode","view","lang"]);
    settingsLoaded = {
      moodMode: stored.moodMode || "auto",
      view: stored.view || "list",
      lang: stored.lang || "ja",
    };
  } catch(err){ console.error("newtab: failed to load settings", err); }
  currentLang = settingsLoaded.lang;
  currentView = settingsLoaded.view;

  let uid = 0;
  // independent: a failure loading one must not take down the others — previously these
  // were sequential awaits inside one try/catch, so an error in loadFolders() silently
  // skipped the tabs sections entirely
  const [folderResult, openResult, closedResult] = await Promise.allSettled([
    loadFolders(),
    loadOpenTabsSection(),
    loadClosedTabsSection(),
  ]);
  if(folderResult.status === "rejected") console.error("newtab: failed to load bookmarks", folderResult.reason);
  if(openResult.status === "rejected") console.error("newtab: failed to load open tabs", openResult.reason);
  if(closedResult.status === "rejected") console.error("newtab: failed to load closed tabs", closedResult.reason);

  const folderSections = folderResult.status === "fulfilled" ? folderResult.value : [];
  const openSection = openResult.status === "fulfilled" ? openResult.value : null;
  const closedSection = closedResult.status === "fulfilled" ? closedResult.value : null;
  const allSections = [...folderSections, openSection, closedSection].filter(Boolean);

  sections = allSections.map(f => ({ ...f, items: f.items.map(i => ({ ...i, id: uid++ })) }));

  // view was already applied to currentView above; reflect it in the DOM classes too
  if(currentView === "grid"){
    gridEl.classList.add("active"); listEl.classList.remove("active");
  } else {
    listEl.classList.add("active"); gridEl.classList.remove("active");
  }

  setMood(settingsLoaded.moodMode === "auto" ? moodForHour(new Date().getHours()) : settingsLoaded.moodMode);
  render();
}
init();
