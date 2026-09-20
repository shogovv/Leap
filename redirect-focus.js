// Chrome force-focuses the omnibox on the *initial* navigation of a freshly created tab —
// that protection can't be overridden by any script (Chrome 27+, deliberately). But a
// same-tab navigation *after* that initial one isn't treated as "a new tab just opened",
// so it isn't protected the same way. Redirecting to ourselves once, immediately, trades
// a brief reload flicker for the search field actually being able to keep focus afterward
// instead of losing it to the omnibox every time. (Technique via chromium-extensions
// mailing list: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/abJf8SLWMSM)
if(!location.search){
  location.search = "?focus";
}
