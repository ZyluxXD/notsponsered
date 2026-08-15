// loader of content.js
(async () => {
    const src = chrome.runtime.getURL('content.js');
    await import(src);
})();
