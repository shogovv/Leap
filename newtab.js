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
const queryInput = document.getElementById("queryInput");
const matchCountEl = document.getElementById("matchCount");
const greetingEl = document.getElementById("greeting");
const starsEl = document.getElementById("stars");
const tooltipEl = document.getElementById("tooltip");
const webSearchBtn = document.getElementById("btnWebSearch");
const searchBarEl = document.getElementById("searchBar");
const contentEl = document.getElementById("content");

// ===== site search: registered "shortcut → %s URL" search engines =====
// data model: { id, name, keyword, url, icon, color }[], persisted in chrome.storage.local
// under "siteSearches". `color` is a var(--accentN) string assigned once at creation from
// ACCENT_CYCLE (same pool folders use) so a chip's color stays put even if other entries
// are later deleted. `icon` is either an emoji/text glyph or a data: URL the user uploaded.
let siteSearches = [];
let activeSiteSearch = null; // the matched entry once a "<keyword> " prefix has locked in

function saveSiteSearches(){
  try { chrome.storage.local.set({ siteSearches }); } catch {}
}
function findSiteSearch(keyword){
  return siteSearches.find(s => s.keyword.toLowerCase() === keyword.toLowerCase());
}
// only an exact match on the token before the first space activates — the same rule
// Chrome's own omnibox keywords use, and why an ordinary multi-word search essentially
// never collides with a registered shortcut by accident
function matchSiteSearchPrefix(value){
  const m = value.match(/^(\S+)\s(.*)$/);
  if(!m) return null;
  const entry = findSiteSearch(m[1]);
  return entry ? { entry, remainder: m[2] } : null;
}

const engineChipIcoBadgeEl = document.getElementById("engineChipIcoBadge");
const engineChipNameEl = document.getElementById("engineChipName");
const engineChipCloseEl = document.getElementById("engineChipClose");
const enginePanelEl = document.getElementById("enginePanel");
const enginePanelIcoEl = document.getElementById("enginePanelIco");
const enginePanelPrefixEl = document.getElementById("enginePanelPrefix");
const enginePanelNameEl = document.getElementById("enginePanelName");
const enginePanelSuffixEl = document.getElementById("enginePanelSuffix");
const enginePanelUrlEl = document.getElementById("enginePanelUrl");
const enginePanelHintOpenLabelEl = document.getElementById("enginePanelHintOpenLabel");
const enginePanelHintDismissLabelEl = document.getElementById("enginePanelHintDismissLabel");

// icon rendering is shared by the chip, the preview panel, the settings list, and the
// dialog's own preview swatch — an uploaded icon is a data: URL, anything else is shown as
// literal text (an emoji, almost always)
function renderIconInto(container, icon){
  container.innerHTML = "";
  if(typeof icon === "string" && icon.startsWith("data:")){
    const img = document.createElement("img");
    img.src = icon;
    container.appendChild(img);
  } else {
    container.textContent = icon || "🔎";
  }
}

// "{name}を検索" (ja) vs "Search {name}" (en) — word order differs, so the template is
// split around the placeholder once (on init/language switch) into a prefix/suffix that
// wrap a separate, frequently-updated name span
function applySiteSearchLeadTemplate(){
  const template = t("siteSearchLead");
  const idx = template.indexOf("{name}");
  if(idx === -1){ enginePanelPrefixEl.textContent = ""; enginePanelSuffixEl.textContent = template; return; }
  enginePanelPrefixEl.textContent = template.slice(0, idx);
  enginePanelSuffixEl.textContent = template.slice(idx + "{name}".length);
}

function updateSiteSearchPreview(){
  if(!activeSiteSearch) return;
  const q = queryInput.value;
  enginePanelUrlEl.textContent = activeSiteSearch.url.replace("%s", encodeURIComponent(q));
  matchCountEl.textContent = q ? t("siteSearchPreviewQuery").replace("{query}", q) : t("siteSearchPreviewEmpty");
}

// re-paints the chip/panel from activeSiteSearch's current data — needed whenever the
// active entry's own fields change out from under it (editing it in the dialog, or an
// import that updates it by keyword) without going through activate/deactivate. Without
// this the DOM (name, icon, --engine-color) stays stale even though the object itself
// (same reference activeSiteSearch points to) already has the new values, so Enter would
// silently navigate to a new URL while the chip still shows the old name/icon/color.
function syncActiveSiteSearchUI(){
  if(!activeSiteSearch) return;
  document.body.style.setProperty("--engine-color", activeSiteSearch.color);
  renderIconInto(engineChipIcoBadgeEl, activeSiteSearch.icon);
  engineChipNameEl.textContent = activeSiteSearch.name;
  renderIconInto(enginePanelIcoEl, activeSiteSearch.icon);
  enginePanelNameEl.textContent = activeSiteSearch.name;
  updateSiteSearchPreview();
}

function activateSiteSearch(entry, remainder){
  activeSiteSearch = entry;
  hideTooltip();
  searchBarEl.classList.add("engine-active");
  // set on body, not just the bar — .engine-panel lives under #content, not under
  // #searchBar, so a CSS variable set only on the bar never reaches it (it'd silently
  // fall back to --accent1 for every entry's border/name color/confirm flash)
  document.body.style.setProperty("--engine-color", entry.color);
  renderIconInto(engineChipIcoBadgeEl, entry.icon);
  engineChipNameEl.textContent = entry.name;
  renderIconInto(enginePanelIcoEl, entry.icon);
  enginePanelNameEl.textContent = entry.name;
  emptyEl.classList.remove("show");
  contentEl.classList.add("engine-mode");
  webSearchBtn.classList.add("muted");
  // clear any hints/selection left over from just before activating — the grid/list stay
  // rendered underneath (just dimmed), but are no longer the keyboard's target
  document.querySelectorAll(".hint").forEach(h=>h.remove());
  activeHints = {};
  selectedIndex = -1;
  queryInput.value = remainder;
  updateSiteSearchPreview();
}

function deactivateSiteSearch(){
  activeSiteSearch = null;
  searchBarEl.classList.remove("engine-active");
  contentEl.classList.remove("engine-mode");
  webSearchBtn.classList.remove("muted");
}

// every incremental-search keystroke goes through here first: while a site search is
// active it just updates the preview; otherwise it checks for a fresh "<keyword> " prefix
// before falling back to the normal bookmark/tab render()
function handleQueryChange(){
  if(activeSiteSearch){ updateSiteSearchPreview(); return; }
  const match = matchSiteSearchPrefix(queryInput.value);
  if(match){ activateSiteSearch(match.entry, match.remainder); return; }
  render();
}

// navigates this tab to the built URL — mirrors activate()'s "bookmarks navigate in place"
// behavior and confirmActivate()'s flash-then-go timing, just on the panel instead of an anchor
function fireSiteSearch(){
  if(!activeSiteSearch) return;
  const finalUrl = activeSiteSearch.url.replace("%s", encodeURIComponent(queryInput.value.trim()));
  enginePanelEl.classList.add("firing");
  clearQueryInput(); // silent, same as confirmActivate() — no flash back to the normal view first
  setTimeout(()=>{ location.href = finalUrl; }, CONFIRM_DELAY_MS);
}

engineChipCloseEl.addEventListener("click", ()=>{
  resetQuery();
  queryInput.focus();
});

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

// the empty-state line is rolled once when results first run out and kept while the query
// keeps matching nothing — re-rolling on every keystroke would make it flicker
let emptyLineIndex = -1;
const EMPTY_QUERY_MAX = 24;
function renderEmptyState(isEmpty){
  emptyEl.classList.toggle("show", isEmpty);
  if(!isEmpty){ emptyLineIndex = -1; return; }
  const pool = EMPTY_STATES[currentLang] || EMPTY_STATES.ja;
  if(emptyLineIndex < 0 || emptyLineIndex >= pool.length) emptyLineIndex = Math.floor(Math.random() * pool.length);
  emptyEl.textContent = "";
  const main = document.createElement("div");
  main.textContent = pool[emptyLineIndex];
  emptyEl.appendChild(main);
  const q = queryInput.value.trim();
  if(q){
    const shown = q.length > EMPTY_QUERY_MAX ? q.slice(0, EMPTY_QUERY_MAX) + "…" : q;
    const sub = document.createElement("div");
    sub.className = "empty-hint";
    // a URL-like query opens directly on Enter (see the keydown handler) rather than
    // falling back to a web search — say so, instead of the generic "web search" hint
    sub.textContent = t(isUrlLike(q) ? "emptyHintUrl" : "emptyHint").replace("{query}", shown);
    emptyEl.appendChild(sub);
  }
}

function render(){
  // a site search chip owns the bar/panel while active — render()/applyHints() would
  // otherwise stomp matchCountEl and the web-search button's "selected" look the moment
  // anything calls render() for an unrelated reason (window regaining focus, a language
  // switch) while a site search is active
  if(activeSiteSearch){ updateSiteSearchPreview(); return; }
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

  renderEmptyState(!anyVisible);
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
  // while a site search is active the grid/list stay rendered underneath (just dimmed and
  // non-interactive) — keyboard navigation shouldn't move a hidden selection around behind
  // the panel, so every caller of this (arrows, Tab, Ctrl+P/N, Ctrl+letter hints) sees none
  if(activeSiteSearch) return [];
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

// geometric neighbor search for the arrow keys — works for both the list grid and the
// masonry widget view without knowing their column counts, since it just looks at real
// rendered positions (getBoundingClientRect) rather than assuming a fixed row width
function findSpatialNeighbor(anchors, fromIndex, dx, dy){
  if(fromIndex < 0 || fromIndex >= anchors.length) return fromIndex;
  const cur = anchors[fromIndex].getBoundingClientRect();
  const curX = cur.left + cur.width / 2;
  const curY = cur.top + cur.height / 2;
  let best = -1;
  let bestScore = Infinity;
  anchors.forEach((a, i) => {
    if(i === fromIndex) return;
    const r = a.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const ddx = cx - curX;
    const ddy = cy - curY;
    if(dy !== 0){
      if(dy > 0 ? ddy <= 2 : ddy >= -2) return; // must actually be below/above
      const score = Math.abs(ddy) + Math.abs(ddx) * 0.5;
      if(score < bestScore){ bestScore = score; best = i; }
    } else {
      if(dx > 0 ? ddx <= 2 : ddx >= -2) return; // must actually be right/left
      const score = Math.abs(ddx) + Math.abs(ddy) * 0.5;
      if(score < bestScore){ bestScore = score; best = i; }
    }
  });
  return best === -1 ? fromIndex : best;
}
function moveSelectionSpatial(dx, dy){
  const anchors = getVisibleAnchors();
  if(!anchors.length) return;
  if(selectedIndex < 0) selectedIndex = 0;
  selectedIndex = findSpatialNeighbor(anchors, selectedIndex, dx, dy);
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

  // zero local matches (with something actually typed) means Enter now falls through to
  // web search too — move the "you're about to activate this" look over to that button
  webSearchBtn.classList.toggle("selected", !!query && visibleAnchors.length === 0);
}

// clears the query without rendering — use this right before leaving the page (navigating
// away or switching tabs), so the full list doesn't flash back into view while we're still
// visible for that one frame. render() then only happens once we're actually back (focus).
function clearQueryInput(){ queryInput.value = ""; }
function resetQuery(){
  if(activeSiteSearch) deactivateSiteSearch();
  clearQueryInput();
  render();
}

// whatever's currently in the query field, typed or pasted — if it looks like a URL, Enter
// opens it directly (see the keydown handler) instead of activating a selected result or
// falling back to a web search
function isUrlLike(text){
  const t = text.trim();
  if(!t || /\s/.test(t)) return false;
  if(/^https?:\/\//i.test(t)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9]{2,}(\/\S*)?$/i.test(t);
}
// bare domains (no scheme) are assumed https:// — used wherever a user-supplied URL-ish
// string needs to become an actual navigable URL (opening a typed/pasted URL, saving a site
// search's template, importing one)
function ensureScheme(url){
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
}

// forced web search — always available via Ctrl+Enter/Cmd+Enter or the button, and also
// what a plain Enter falls back to once there are zero local matches (see the keydown
// handler and applyHints()'s toggling of webSearchBtn's "selected" look)
async function doWebSearch(){
  const query = queryInput.value.trim();
  if(!query) return;
  try {
    await chrome.search.query({ text: query, disposition: "CURRENT_TAB" });
  } catch(err){ console.error("newtab: web search failed", err); }
}

// Chrome gives no reliable way to veto/cancel IME composition from JS (blur+refocus was
// tried and it scrambles the composition instead of cancelling it) — so we let IME work
// normally and just avoid filtering on the not-yet-committed in-progress text: input
// events fire per keystroke during composition too, with isComposing:true on each one,
// so skip those and only search once the reading is actually committed.
queryInput.addEventListener("input", (e)=>{
  if(e.isComposing) return;
  handleQueryChange();
});
queryInput.addEventListener("compositionend", ()=>{ handleQueryChange(); });
// pasting a URL used to preventDefault() and navigate immediately, bypassing the field
// entirely — but location.href assignment isn't instant (DNS/TCP/etc.), so this page stayed
// live and focused for a beat after. The "Cmd+V, Enter" muscle memory from the omnibox kept
// firing that second Enter anyway, and it landed on the still-visible page: with nothing
// yet in the (deliberately left empty) field, the first result was still selected, so it
// opened the top bookmark instead of the pasted URL. Letting the paste land in the field
// normally and having Enter open it (below) matches what the omnibox itself actually does —
// paste, then Enter — and there's no longer a window where a stray Enter does the wrong thing.
queryInput.addEventListener("keydown", (e)=>{
  if(e.key === "Escape"){ e.preventDefault(); resetQuery(); return; }
  // caret sitting right after the chip (position 0 of the remainder) + Backspace un-does
  // the activation instead of eating into the shortcut text — puts "<keyword> " back so
  // the same keystroke that made the chip can un-make it
  if(activeSiteSearch && e.key === "Backspace" && queryInput.selectionStart === 0 && queryInput.selectionEnd === 0){
    e.preventDefault();
    const keyword = activeSiteSearch.keyword;
    deactivateSiteSearch();
    queryInput.value = keyword + " ";
    render();
    requestAnimationFrame(()=>{ queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length); });
    return;
  }
  if(e.key === "Enter"){
    // the Enter that confirms an IME conversion (isComposing, or keyCode 229 on browsers
    // that already report isComposing:false by the time this fires) must not also activate
    // a result — otherwise finishing kanji conversion doubles as "open the top bookmark"
    if(e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    // Ctrl+Enter is always the escape hatch to a plain default-engine search, even while a
    // site search is active — see philosophy.md for why that "way out" has to stay reachable
    if(e.ctrlKey || e.metaKey){ doWebSearch(); return; }
    if(activeSiteSearch){ fireSiteSearch(); return; }
    // a URL-like field always opens directly, regardless of what's selected below it — if
    // you typed or pasted a full URL, that's where Enter should go, not to a bookmark that
    // happens to match some of that text
    if(isUrlLike(queryInput.value)){ location.href = ensureScheme(queryInput.value.trim()); return; }
    const anchors = getVisibleAnchors();
    if(anchors[selectedIndex]) confirmActivate(anchors[selectedIndex]);
    else doWebSearch();
    return;
  }
  // plain arrow keys always navigate results, not just Ctrl+P/N — including Left/Right,
  // which means they no longer move the text cursor within the query. Tried gating
  // Left/Right on the cursor being at that edge first, but that made them feel like they
  // "were" cursor movement most of the time; consistent selection-navigation won out.
  if(e.key === "ArrowUp"){ e.preventDefault(); moveSelectionSpatial(0, -1); return; }
  if(e.key === "ArrowDown"){ e.preventDefault(); moveSelectionSpatial(0, 1); return; }
  if(e.key === "ArrowLeft"){ e.preventDefault(); moveSelectionSpatial(-1, 0); return; }
  if(e.key === "ArrowRight"){ e.preventDefault(); moveSelectionSpatial(1, 0); return; }
  // Tab/Shift+Tab move the selection the same way Ctrl+P/N do, instead of leaving the
  // query field — there's nothing else on the page worth tabbing to.
  if(e.key === "Tab"){ e.preventDefault(); moveSelection(e.shiftKey ? -1 : 1); return; }
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
// closing whichever modal is open takes priority, regardless of what has focus. The site
// search dialog nests on top of the settings modal, so it gets first refusal.
document.addEventListener("keydown", (e)=>{
  if(e.key !== "Escape") return;
  if(isSiteSearchDialogOpen()){ e.preventDefault(); e.stopPropagation(); closeSiteSearchDialog(); return; }
  if(isModalOpen()){ e.preventDefault(); e.stopPropagation(); closeModal(); }
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

webSearchBtn.addEventListener("click", ()=>{ doWebSearch(); queryInput.focus(); });

// picked once per page load (and re-rolled on a language switch) — just a friendlier
// placeholder than a plain "search", varied so it doesn't feel static every new tab
function rollPlaceholder(){
  const pool = PLACEHOLDERS[currentLang] || PLACEHOLDERS.ja;
  queryInput.placeholder = pool[Math.floor(Math.random() * pool.length)];
}

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

// mode "plain": the "key" column isn't a real keystroke (e.g. "type letters", "paste it",
// "your own shortcut + Space") — render as plain muted text, not a .kbd pill.
// mode "badges" (default): the i18n value is one or more "|"-separated key tokens, each its
// own .kbd pill (so "←/→(Ctrl+P/N, Tab/Shift+Tab)" doesn't get crammed into a single
// unreadable badge), optionally followed by "::<note>" — a non-key condition rendered as
// small plain text after the badges instead of inside one.
const HELP_ROWS = [
  ["helpNarrow","helpNarrowKey","plain"], ["helpAnd","helpAndKey"], ["helpPasteUrl","helpPasteUrlKey","plain"],
  ["helpMoveUpDown","helpMoveUpDownKey"], ["helpMoveLeftRight","helpMoveLeftRightKey"],
  ["helpOpen","helpOpenKey"], ["helpWebSearch","helpWebSearchKey"],
  ["helpSiteSearch","helpSiteSearchKey","plain"],
  ["helpJump","helpJumpKey"], ["helpClear","helpClearKey"],
];

// static labels outside the settings modal that still need re-applying on init/language
// switch — the chip's tooltip and the always-mounted engine panel's hint row
function applySiteSearchStaticLabels(){
  engineChipCloseEl.title = t("siteSearchDismissTooltip");
  enginePanelHintOpenLabelEl.textContent = t("siteSearchHintOpen");
  enginePanelHintDismissLabelEl.textContent = t("siteSearchHintDismiss");
  applySiteSearchLeadTemplate();
  if(activeSiteSearch) updateSiteSearchPreview();
}

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
  // the 5 concrete moods sit in their own grid below the full-width "auto" row — "auto" is
  // a different kind of choice ("let the clock decide"), not one more option among equals
  const moodGrid = document.createElement("div");
  moodGrid.className = "mood-grid";
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
    moodGrid.appendChild(row);
  });
  moodListEl.appendChild(moodGrid);
  updateMoodRowsUI();

  document.getElementById("langLabel").textContent = t("langLabel");
  document.getElementById("btnLangJa").classList.toggle("active", currentLang === "ja");
  document.getElementById("btnLangEn").classList.toggle("active", currentLang === "en");

  document.getElementById("editBookmarksLabel").textContent = t("editBookmarks");

  document.getElementById("siteSearchLabel").textContent = t("siteSearchLabel");
  document.getElementById("siteSearchAddLabel").textContent = t("siteSearchAdd");
  document.getElementById("btnExportSiteSearch").title = t("siteSearchExportTooltip");
  document.getElementById("btnImportSiteSearch").title = t("siteSearchImportTooltip");
  document.getElementById("ssIoStatus").textContent = "";
  renderSiteSearchList();

  document.getElementById("helpLabel").textContent = t("helpLabel");
  helpListEl.innerHTML = "";
  HELP_ROWS.forEach(([descKey, keyKey, mode])=>{
    const row = document.createElement("div");
    row.className = "help-row";
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = t(descKey);
    row.appendChild(desc);

    const keysWrap = document.createElement("span");
    keysWrap.className = "help-keys";
    if(mode === "plain"){
      const plain = document.createElement("span");
      plain.className = "help-plain";
      plain.textContent = t(keyKey);
      keysWrap.appendChild(plain);
    } else {
      const [badges, note] = t(keyKey).split("::");
      badges.split("|").forEach(k=>{
        const kbd = document.createElement("span");
        kbd.className = "kbd";
        kbd.textContent = k;
        keysWrap.appendChild(kbd);
      });
      if(note){
        const noteEl = document.createElement("span");
        noteEl.className = "help-note";
        noteEl.textContent = note;
        keysWrap.appendChild(noteEl);
      }
    }
    row.appendChild(keysWrap);
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
  document.documentElement.lang = lang;
  settingsLoaded.lang = lang;
  saveSettings();
  setMood(currentMood); // re-roll the greeting so it matches the new language too
  emptyLineIndex = -1;
  rollPlaceholder();
  document.getElementById("webSearchLabel").textContent = "🔍 " + t("webSearchLabel");
  applySiteSearchStaticLabels();
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

// ===== settings: site search list + add/edit dialog =====
const siteSearchListEl = document.getElementById("siteSearchList");
const btnAddSiteSearch = document.getElementById("btnAddSiteSearch");
const siteSearchDialogBackdrop = document.getElementById("siteSearchDialogBackdrop");
const ssDialogTitleEl = document.getElementById("ssDialogTitle");
const ssFieldNameEl = document.getElementById("ssFieldName");
const ssFieldKeywordEl = document.getElementById("ssFieldKeyword");
const ssFieldUrlEl = document.getElementById("ssFieldUrl");
const ssIconPreviewEl = document.getElementById("ssIconPreview");
const ssIconEmojiInputEl = document.getElementById("ssIconEmojiInput");
const ssIconUploadBtn = document.getElementById("ssIconUploadBtn");
const ssIconFileEl = document.getElementById("ssIconFile");
const ssIconSuggestionsEl = document.getElementById("ssIconSuggestions");
const ssNameErrorEl = document.getElementById("ssNameError");
const ssKeywordErrorEl = document.getElementById("ssKeywordError");
const ssUrlErrorEl = document.getElementById("ssUrlError");
const ssIconErrorEl = document.getElementById("ssIconError");
const ssCancelBtn = document.getElementById("ssCancelBtn");
const ssSaveBtn = document.getElementById("ssSaveBtn");
const ssDialogClose = document.getElementById("ssDialogClose");
const btnExportSiteSearch = document.getElementById("btnExportSiteSearch");
const btnImportSiteSearch = document.getElementById("btnImportSiteSearch");
const ssImportFileEl = document.getElementById("ssImportFile");
const ssIoStatusEl = document.getElementById("ssIoStatus");

const ICON_SUGGESTIONS = ["📦","🛒","🔎","⭐","📺","🎬","💻","📚","🍔","✈️","🎵","🐦","💰","📰","🎨","🏠"];
const ICON_MAX_BYTES = 200 * 1024; // uploaded icons are stored as data: URLs directly in
  // chrome.storage.local — kept small since there's no compression, just a size guard
let editingSiteSearchId = null; // null while the dialog is adding a brand new entry
let editingIcon = "🔎"; // the dialog's current icon value — emoji text, or a data: URL

function isSiteSearchDialogOpen(){ return siteSearchDialogBackdrop.classList.contains("show"); }

function renderSiteSearchList(){
  siteSearchListEl.innerHTML = "";
  if(!siteSearches.length){
    const empty = document.createElement("div");
    empty.className = "ss-empty";
    empty.textContent = t("siteSearchEmpty");
    siteSearchListEl.appendChild(empty);
    return;
  }
  siteSearches.forEach(entry=>{
    const row = document.createElement("div");
    row.className = "ss-row";

    const iconEl = document.createElement("span");
    iconEl.className = "ss-icon";
    renderIconInto(iconEl, entry.icon);

    const nameEl = document.createElement("span");
    nameEl.className = "ss-name";
    nameEl.textContent = entry.name;

    const shortcutEl = document.createElement("span");
    shortcutEl.className = "ss-shortcut";
    shortcutEl.textContent = entry.keyword;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "row-icon-btn";
    editBtn.title = t("siteSearchEditTooltip");
    editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    editBtn.addEventListener("click", ()=>openSiteSearchDialog(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "row-icon-btn";
    deleteBtn.title = t("siteSearchDeleteTooltip");
    deleteBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
    deleteBtn.addEventListener("click", ()=>deleteSiteSearch(entry.id));

    row.append(iconEl, nameEl, shortcutEl, editBtn, deleteBtn);
    siteSearchListEl.appendChild(row);
  });
}

function deleteSiteSearch(id){
  siteSearches = siteSearches.filter(s => s.id !== id);
  saveSiteSearches();
  renderSiteSearchList();
  if(activeSiteSearch && activeSiteSearch.id === id) resetQuery(); // deleting the active one drops back to normal search
}

function setIconPreview(icon){
  editingIcon = icon;
  renderIconInto(ssIconPreviewEl, icon);
}

function renderIconSuggestions(){
  ssIconSuggestionsEl.innerHTML = "";
  ICON_SUGGESTIONS.forEach(emoji=>{
    const sw = document.createElement("div");
    sw.className = "icon-swatch";
    sw.textContent = emoji;
    // suggestions are shortcuts, not the only choices — the emoji field above accepts
    // literally anything typed or pasted, including via the OS emoji picker
    sw.addEventListener("click", ()=>{
      ssIconEmojiInputEl.value = emoji;
      setIconPreview(emoji);
    });
    ssIconSuggestionsEl.appendChild(sw);
  });
}
renderIconSuggestions();

function openSiteSearchDialog(id){
  editingSiteSearchId = id;
  const entry = id ? siteSearches.find(s => s.id === id) : null;
  ssDialogTitleEl.textContent = entry ? t("siteSearchDialogEditTitle") : t("siteSearchDialogAddTitle");
  document.getElementById("ssFieldNameLabel").textContent = t("siteSearchFieldName");
  document.getElementById("ssFieldKeywordLabel").textContent = t("siteSearchFieldKeyword");
  document.getElementById("ssFieldUrlLabel").textContent = t("siteSearchFieldUrl");
  document.getElementById("ssFieldIconLabel").textContent = t("siteSearchFieldIcon");
  document.getElementById("ssIconHint").textContent = t("siteSearchIconHint");
  ssIconUploadBtn.textContent = t("siteSearchIconUpload");
  ssCancelBtn.textContent = t("siteSearchCancel");
  ssSaveBtn.textContent = t("siteSearchSave");

  ssFieldNameEl.value = entry ? entry.name : "";
  ssFieldKeywordEl.value = entry ? entry.keyword : "";
  ssFieldUrlEl.value = entry ? entry.url : "";
  const startIcon = entry ? entry.icon : "🔎";
  ssIconEmojiInputEl.value = startIcon.startsWith("data:") ? "" : startIcon;
  setIconPreview(startIcon);
  [ssNameErrorEl, ssKeywordErrorEl, ssUrlErrorEl, ssIconErrorEl].forEach(el=>el.classList.remove("show"));

  siteSearchDialogBackdrop.classList.add("show");
  ssFieldNameEl.focus();
}
function closeSiteSearchDialog(){
  siteSearchDialogBackdrop.classList.remove("show");
  queryInput.focus();
}

function newSiteSearchId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function saveSiteSearchDialog(){
  const name = ssFieldNameEl.value.trim();
  const keyword = ssFieldKeywordEl.value.trim();
  // without this, a scheme-less template becomes a *relative* location.href assignment
  // (resolves against the extension's own origin) instead of navigating to the intended site
  let url = ssFieldUrlEl.value.trim();
  if(url) url = ensureScheme(url);
  let ok = true;
  ssNameErrorEl.classList.remove("show");
  ssKeywordErrorEl.classList.remove("show");
  ssUrlErrorEl.classList.remove("show");

  if(!name){ ssNameErrorEl.textContent = t("siteSearchErrName"); ssNameErrorEl.classList.add("show"); ok = false; }
  if(!keyword || /\s/.test(keyword)){
    ssKeywordErrorEl.textContent = t("siteSearchErrKeyword"); ssKeywordErrorEl.classList.add("show"); ok = false;
  } else {
    const dup = siteSearches.find(s => s.id !== editingSiteSearchId && s.keyword.toLowerCase() === keyword.toLowerCase());
    if(dup){ ssKeywordErrorEl.textContent = t("siteSearchErrKeywordDup"); ssKeywordErrorEl.classList.add("show"); ok = false; }
  }
  if(!url || !url.includes("%s")){ ssUrlErrorEl.textContent = t("siteSearchErrUrl"); ssUrlErrorEl.classList.add("show"); ok = false; }
  if(!ok) return;

  const icon = editingIcon || "🔎";
  if(editingSiteSearchId){
    const entry = siteSearches.find(s => s.id === editingSiteSearchId);
    entry.name = name; entry.keyword = keyword; entry.url = url; entry.icon = icon;
    // keep the live chip/panel in sync if the entry being edited is the one active right now
    if(activeSiteSearch && activeSiteSearch.id === entry.id) syncActiveSiteSearchUI();
  } else {
    siteSearches.push({
      id: newSiteSearchId(), name, keyword, url, icon,
      color: ACCENT_CYCLE[siteSearches.length % ACCENT_CYCLE.length],
    });
  }
  saveSiteSearches();
  renderSiteSearchList();
  closeSiteSearchDialog();
}

// ===== export/import: a JSON file holding the same shape saveSiteSearchDialog() writes =====
// (icons come along as-is — a data: URL uploaded icon round-trips fine as a JSON string)
function exportSiteSearches(){
  const blob = new Blob([JSON.stringify(siteSearches, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "leap-site-searches.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// same shape rules as saveSiteSearchDialog()'s own validation (name/keyword required, no
// whitespace in the keyword, %s in the URL, https:// prepended if missing) — returns null
// for anything that doesn't qualify, so a bad file just silently drops the bad rows
function normalizeImportedSiteSearch(raw){
  if(!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const keyword = typeof raw.keyword === "string" ? raw.keyword.trim() : "";
  let url = typeof raw.url === "string" ? raw.url.trim() : "";
  if(url) url = ensureScheme(url);
  if(!name || !keyword || /\s/.test(keyword) || !url || !url.includes("%s")) return null;
  const icon = typeof raw.icon === "string" && raw.icon ? raw.icon : "🔎";
  const color = typeof raw.color === "string" && /^var\(--accent\d\)$/.test(raw.color) ? raw.color : null;
  return { name, keyword, url, icon, color };
}

// merges by keyword: an imported entry whose keyword already exists updates that entry in
// place (keeping its id/color unless the import specifies its own valid color); anything new
// is appended — this is what makes re-importing a backup, or a file shared by someone else,
// actually useful instead of just erroring on the first collision
function importSiteSearches(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    let imported;
    try { imported = JSON.parse(reader.result); } catch { imported = null; }
    if(!Array.isArray(imported)){
      ssIoStatusEl.textContent = t("siteSearchImportError");
      ssIoStatusEl.classList.add("error");
      return;
    }
    let count = 0;
    let activeWasUpdated = false;
    imported.forEach(raw=>{
      const clean = normalizeImportedSiteSearch(raw);
      if(!clean) return;
      const existing = siteSearches.find(s => s.keyword.toLowerCase() === clean.keyword.toLowerCase());
      if(existing){
        existing.name = clean.name; existing.url = clean.url; existing.icon = clean.icon;
        if(clean.color) existing.color = clean.color;
        if(activeSiteSearch && activeSiteSearch.id === existing.id) activeWasUpdated = true;
      } else {
        siteSearches.push({
          id: newSiteSearchId(),
          name: clean.name, keyword: clean.keyword, url: clean.url, icon: clean.icon,
          color: clean.color || ACCENT_CYCLE[siteSearches.length % ACCENT_CYCLE.length],
        });
      }
      count++;
    });
    // the imported entry and activeSiteSearch are the same object (siteSearches.find()
    // returns the live reference), so its data is already correct — only the DOM is stale
    if(activeWasUpdated) syncActiveSiteSearchUI();
    if(count > 0){
      saveSiteSearches();
      renderSiteSearchList();
      ssIoStatusEl.textContent = t("siteSearchImportSuccess").replace("{count}", count);
      ssIoStatusEl.classList.remove("error");
    } else {
      ssIoStatusEl.textContent = t("siteSearchImportEmpty");
      ssIoStatusEl.classList.add("error");
    }
  };
  reader.readAsText(file);
}

btnExportSiteSearch.addEventListener("click", exportSiteSearches);
btnImportSiteSearch.addEventListener("click", ()=> ssImportFileEl.click());
ssImportFileEl.addEventListener("change", ()=>{
  const file = ssImportFileEl.files && ssImportFileEl.files[0];
  ssImportFileEl.value = "";
  if(file) importSiteSearches(file);
});

ssIconEmojiInputEl.addEventListener("input", ()=>{ setIconPreview(ssIconEmojiInputEl.value || "🔎"); });
ssIconUploadBtn.addEventListener("click", ()=> ssIconFileEl.click());
ssIconFileEl.addEventListener("change", ()=>{
  const file = ssIconFileEl.files && ssIconFileEl.files[0];
  ssIconFileEl.value = "";
  if(!file) return;
  if(file.size > ICON_MAX_BYTES){
    ssIconErrorEl.textContent = t("siteSearchIconTooLarge");
    ssIconErrorEl.classList.add("show");
    return;
  }
  ssIconErrorEl.classList.remove("show");
  const reader = new FileReader();
  reader.onload = ()=>{
    ssIconEmojiInputEl.value = "";
    setIconPreview(reader.result);
  };
  reader.readAsDataURL(file);
});

btnAddSiteSearch.addEventListener("click", ()=>openSiteSearchDialog(null));
ssCancelBtn.addEventListener("click", closeSiteSearchDialog);
ssDialogClose.addEventListener("click", closeSiteSearchDialog);
ssSaveBtn.addEventListener("click", saveSiteSearchDialog);
siteSearchDialogBackdrop.addEventListener("click", (e)=>{ if(e.target === siteSearchDialogBackdrop) closeSiteSearchDialog(); });
// Enter anywhere in the dialog saves it, same one-key-does-the-obvious-thing feel as the
// rest of the app — there's no multi-line field here for Enter to legitimately mean something else
siteSearchDialogBackdrop.addEventListener("keydown", (e)=>{
  // same IME-confirm guard as queryInput's — without keyCode 229 too, finishing kanji
  // conversion in the name field would save (and close) the dialog mid-edit
  if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); saveSiteSearchDialog(); }
});

function tick(){
  const now = new Date();
  const locale = currentLang === "en" ? "en-US" : "ja-JP";
  document.getElementById("time").textContent = now.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  document.getElementById("date").textContent = now.toLocaleDateString(locale,{year:'numeric',month:'long',day:'numeric',weekday:'long'});
}
tick(); setInterval(tick,1000*30);

async function init(){
  // load persisted settings first — the language affects loadFolders()'s "untitled
  // folder" fallback text, and moodMode decides whether we even call moodForHour()
  try {
    const stored = await chrome.storage.local.get(["moodMode","view","lang","siteSearches"]);
    settingsLoaded = {
      moodMode: stored.moodMode || "auto",
      view: stored.view || "list",
      lang: stored.lang || "ja",
    };
    siteSearches = Array.isArray(stored.siteSearches) ? stored.siteSearches : [];
  } catch(err){ console.error("newtab: failed to load settings", err); }
  currentLang = settingsLoaded.lang;
  document.documentElement.lang = currentLang;
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
  rollPlaceholder();
  document.getElementById("webSearchLabel").textContent = "🔍 " + t("webSearchLabel");
  applySiteSearchStaticLabels();
  render();
}
init();
