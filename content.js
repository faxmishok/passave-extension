// Listen for messages from our popup
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === 'autofill') {
    const passwordField = document.querySelector('input[type="password"]');
    const usernameField = document.querySelector(
      'input[type="email"], input[type="text"], input[name*="user"], input[name*="email"]',
    );

    let filledAnything = false;

    if (passwordField && request.password) {
      passwordField.value = request.password;
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      filledAnything = true;
    }

    if (usernameField && request.username) {
      usernameField.value = request.username;
      usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      filledAnything = true;
    }

    if (filledAnything) {
      sendResponse({ success: true, message: 'Ninja strike successful!' });
    } else {
      sendResponse({ success: false, message: 'No login fields found.' });
    }
  }
  return true;
});

// --- INLINE AUTOFILL LOGIC ---
document.addEventListener('focusin', function (e) {
  const target = e.target;

  if (
    target.tagName === 'INPUT' &&
    (target.type === 'password' ||
      target.type === 'email' ||
      target.type === 'text')
  ) {
    // Fetch both the vault AND the theme from storage
    chrome.storage.local.get(['vault', 'theme'], function (result) {
      if (!result.vault || result.vault.length === 0) return;

      const currentDomain = window.location.hostname.replace(/^www\./, '');
      const matches = result.vault.filter((save) => {
        try {
          const saveDomain = new URL(save.loginURL).hostname.replace(
            /^www\./,
            '',
          );
          return saveDomain === currentDomain;
        } catch (err) {
          return false;
        }
      });

      if (matches.length > 0) {
        showSuggestionBox(target, matches, result.theme);
      }
    });
  }
});

function showSuggestionBox(inputElement, matches, currentTheme) {
  if (document.getElementById('passave-inline-box')) {
    document.getElementById('passave-inline-box').remove();
  }

  const box = document.createElement('div');
  box.id = 'passave-inline-box';

  // Determine colors based on the theme from storage
  const isLight = currentTheme === 'light';
  const bgColor = isLight ? '#ffffff' : '#1f2937';
  const borderColor = isLight ? '#d1d5db' : '#374151';
  const hoverColor = isLight ? '#f3f4f6' : '#374151';
  const textColor = isLight ? '#4b5563' : '#d1d5db';
  const titleColor = isLight ? '#0d9488' : '#2dd4bf'; // Teal

  // Theme-aware inline styles
  box.style.position = 'absolute';
  box.style.backgroundColor = bgColor;
  box.style.border = `1px solid ${borderColor}`;
  box.style.borderRadius = '8px';
  box.style.boxShadow = isLight
    ? '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
    : '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3)';
  box.style.zIndex = '2147483647';
  box.style.padding = '4px 0';
  box.style.minWidth = '220px';
  box.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  box.style.overflow = 'hidden';

  const rect = inputElement.getBoundingClientRect();
  box.style.top = window.scrollY + rect.bottom + 8 + 'px';
  box.style.left = window.scrollX + rect.left + 'px';

  matches.forEach((save) => {
    const item = document.createElement('div');
    item.style.padding = '10px 16px';
    item.style.cursor = 'pointer';
    item.style.borderBottom = `1px solid ${borderColor}`;
    item.style.display = 'flex';
    item.style.flexDirection = 'column';
    item.style.transition = 'background-color 0.15s ease';

    // Hover effects based on theme
    item.onmouseover = () => (item.style.backgroundColor = hoverColor);
    item.onmouseout = () => (item.style.backgroundColor = bgColor);

    // Theme-aware text
    item.innerHTML = `
      <strong style="color: ${titleColor}; font-size: 14px; font-weight: 600; margin-bottom: 2px;">Passave Vault</strong>
      <span style="color: ${textColor}; font-size: 13px;">${save.username}</span>
    `;

    item.addEventListener('mousedown', function (e) {
      e.preventDefault();

      const passwordField = document.querySelector('input[type="password"]');
      const usernameField = document.querySelector(
        'input[type="email"], input[type="text"], input[name*="user"], input[name*="email"]',
      );

      if (passwordField) {
        passwordField.value = save.password_secret;
        passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (usernameField) {
        usernameField.value = save.username;
        usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      }

      box.remove();
    });

    box.appendChild(item);
  });

  if (box.lastChild) box.lastChild.style.borderBottom = 'none';

  document.body.appendChild(box);
}

document.addEventListener('mousedown', function (e) {
  const box = document.getElementById('passave-inline-box');
  if (box && !box.contains(e.target) && e.target.tagName !== 'INPUT') {
    box.remove();
  }
});
