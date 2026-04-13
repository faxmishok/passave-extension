/**
 * PASSAVE — background.js
 * The invisible service worker. Securely fetches credentials for the current page.
 */

const API = 'https://passave.org/api/v1';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CHECK_MATCHES') {
    // 1. Check if the user is currently logged in
    chrome.storage.local.get(['token'], async (result) => {
      if (!result.token) {
        return sendResponse({ success: false, matches: [] });
      }

      try {
        // 2. Fetch the vault from your Express API
        const res = await fetch(`${API}/save/all`, {
          headers: {
            Authorization: `Bearer ${result.token}`,
            Accept: 'application/json',
          },
        });

        // 🛡️ FIX: Catch 401/403 and clear storage, returning a specific error
        if (res.status === 401 || res.status === 403) {
          chrome.storage.local.remove('token');
          return sendResponse({
            success: false,
            error: 'unauthorized',
            matches: [],
          });
        }

        if (!res.ok) {
          return sendResponse({ success: false, matches: [] });
        }

        const data = await res.json();
        const saves = data.saves || [];

        // 🛡️ FIX: Use Regex to only replace a leading 'www.' (case-insensitive)
        const currentDomain = request.domain.replace(/^www\./i, '');

        // 3. Find matches for the exact website the user is on
        const matches = saves.filter((s) => {
          if (!s.loginURL) return false;
          try {
            const saveDomain = new URL(
              s.loginURL.startsWith('http')
                ? s.loginURL
                : 'https://' + s.loginURL,
            ).hostname.replace(/^www\./i, ''); // 🛡️ FIX: Applied regex here too
            return saveDomain === currentDomain;
          } catch {
            return false;
          }
        });

        // 4. Send the matches back to the webpage
        sendResponse({ success: true, matches });
      } catch (err) {
        sendResponse({ success: false, matches: [] });
      }
    });

    // CRITICAL: Return true indicates we will send the response asynchronously
    return true;
  }
});
