(function () {
  try {
    const keys = ['accessToken', 'oai-access-token'];
    for (const key of keys) {
      let value = null;
      try {
        value = window.localStorage.getItem(key);
      } catch (err) {
        console.log('[Bridge] localStorage read failed for', key, String(err && err.message ? err.message : err));
        return;
      }
      if (typeof value === 'string' && value.length > 0) {
        chrome.runtime.sendMessage({ type: 'access-token', token: value }, () => {
          void chrome.runtime.lastError;
        });
        console.log('[Bridge] access token found via', key);
        return;
      }
    }
    console.log('[Bridge] no access token in localStorage');
  } catch (err) {
    console.log('[Bridge] content script error:', String(err && err.message ? err.message : err));
  }
})();
