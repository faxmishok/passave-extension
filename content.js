/**
 * PASSAVE — content.js
 * Smart, focus-driven inline autofill with Username/Email context detection.
 */

let pageCredentials = null;
let activePill = null;

// ─── 1. LISTEN FOR POPUP COMMANDS ─────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AUTOFILL') {
    // If sent from the popup, pass the whole object for smart detection
    const success = executeAutofill(message.data);
    sendResponse({ success });
  }
});

// ─── 2. FETCH MATCHES ON LOAD & SETUP TRACKER ─────────────────
window.addEventListener('load', () => {
  chrome.runtime.sendMessage(
    { type: 'CHECK_MATCHES', domain: window.location.hostname },
    (response) => {
      if (response && response.success && response.matches.length > 0) {
        pageCredentials = response.matches[0];

        // Setup the event listener that tracks where the user clicks
        setupFocusListener();

        // Auto-inject if a field is already focused or available on load
        const { usernameField, passwordField } = getLoginFields();
        if (usernameField || passwordField)
          injectFloatingUI(usernameField || passwordField);
      }
    },
  );
});

// ─── 3. THE FOCUS TRACKER (FIXES X.COM / SPAs) ────────────────
function setupFocusListener() {
  document.addEventListener('focusin', (e) => {
    if (!pageCredentials) return;
    const el = e.target;
    // If the user clicks into an input field, check if it's a login field
    if (el.tagName === 'INPUT' && isLoginField(el)) {
      injectFloatingUI(el);
    }
  });

  // Hide the pill if the user clicks randomly on the background
  document.addEventListener('mousedown', (e) => {
    if (
      activePill &&
      !activePill.contains(e.target) &&
      e.target.tagName !== 'INPUT'
    ) {
      activePill.remove();
      activePill = null;
    }
  });
}

function isLoginField(el) {
  if (el.type === 'password') return true;
  const str = (
    el.name +
    ' ' +
    el.id +
    ' ' +
    el.placeholder +
    ' ' +
    el.type +
    ' ' +
    el.autocomplete
  ).toLowerCase();
  return str.includes('email') || str.includes('user') || str.includes('login');
}

// ─── 4. THE FLOATING UI INJECTOR (RESTORED SIZE) ──────────────
function injectFloatingUI(targetElement) {
  if (!pageCredentials || !isVisible(targetElement)) return;

  // Remove any existing pill before drawing a new one
  if (activePill) activePill.remove();

  const rect = targetElement.getBoundingClientRect();
  activePill = document.createElement('div');
  activePill.id = 'passave-floating-autofill';

  // Restored the larger padding (12px 16px) and bigger dimensions
  activePill.style.cssText = `
    position: absolute;
    top: ${rect.bottom + window.scrollY + 8}px;
    left: ${rect.left + window.scrollX}px;
    z-index: 2147483647;
    background: #13131a;
    border: 1px solid rgba(124, 106, 247, 0.3);
    border-radius: 12px;
    padding: 12px 16px; 
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: system-ui, -apple-system, sans-serif;
    color: #f0f0f5;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    transition: background 0.2s, top 0.2s, left 0.2s;
    animation: passavePop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  if (!document.getElementById('passave-styles')) {
    const styleBlock = document.createElement('style');
    styleBlock.id = 'passave-styles';
    styleBlock.textContent = `
      @keyframes passavePop {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      #passave-floating-autofill:hover {
        background: #1a1a24 !important;
        border-color: rgba(124, 106, 247, 0.6) !important;
      }
    `;
    document.head.appendChild(styleBlock);
  }

  // Display the primary identifier on the button
  const displayId =
    pageCredentials.username || pageCredentials.email || 'Credential';

  activePill.innerHTML = `
    <div style="width: 28px; height: 28px; border-radius: 8px; background: rgba(124, 106, 247, 0.12); display: flex; align-items: center; justify-content: center; color: #9d8fff;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div style="display: flex; flex-direction: column;">
      <span style="font-size: 13px; font-weight: 600; line-height: 1;">Passave Vault</span>
      <span style="font-size: 11px; color: #8888a0; margin-top: 4px;">Autofill • ${displayId}</span>
    </div>
  `;

  // Prevent clicking the pill from stealing focus away from the input field
  activePill.addEventListener('mousedown', (e) => e.preventDefault());

  activePill.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Pass the full credential object so the executor can be smart
    executeAutofill(pageCredentials);

    activePill.innerHTML = `<span style="font-size: 13px; font-weight: 600; color: #50d890; padding: 0 8px;">Autofilled!</span>`;
    setTimeout(() => {
      if (activePill) {
        activePill.style.opacity = '0';
        setTimeout(() => {
          if (activePill) activePill.remove();
          activePill = null;
        }, 200);
      }
    }, 1200);
  });

  document.body.appendChild(activePill);
}

// ─── 5. CORE AUTOFILL & SMART DETECTION ENGINE ────────────────
function getLoginFields() {
  const passwordFields = Array.from(
    document.querySelectorAll('input[type="password"]'),
  ).filter(isVisible);

  const usernameSelectors = [
    'input[type="email"]',
    'input[type="text"][autocomplete*="email"]',
    'input[type="text"][autocomplete*="username"]',
    'input[type="text"][name*="email"]',
    'input[type="text"][name*="user"]',
    'input[type="text"]',
  ];

  let usernameField = null;
  for (const selector of usernameSelectors) {
    const found = Array.from(document.querySelectorAll(selector)).filter(
      isVisible,
    );
    if (found.length) {
      usernameField = found[0];
      break;
    }
  }

  // Fallback: guess the field before the password is the username
  if (passwordFields.length && !usernameField) {
    const allInputs = Array.from(document.querySelectorAll('input')).filter(
      isVisible,
    );
    const pwIdx = allInputs.indexOf(passwordFields[0]);
    if (pwIdx > 0) usernameField = allInputs[pwIdx - 1];
  }

  return { usernameField, passwordField: passwordFields[0] };
}

function executeAutofill(credential) {
  let filled = 0;
  const { usernameField, passwordField } = getLoginFields();

  // 🎯 THE SMART DETECTION LOGIC
  if (usernameField) {
    const str = (
      usernameField.name +
      ' ' +
      usernameField.id +
      ' ' +
      usernameField.placeholder +
      ' ' +
      usernameField.type
    ).toLowerCase();

    // Check if there is an explicit HTML <label> associated with this input
    let associatedLabel = '';
    if (usernameField.id) {
      const lbl = document.querySelector(`label[for="${usernameField.id}"]`);
      if (lbl) associatedLabel = lbl.innerText.toLowerCase();
    }

    const wantsEmail =
      str.includes('email') ||
      associatedLabel.includes('email') ||
      usernameField.type === 'email';
    const wantsUsername =
      str.includes('user') || associatedLabel.includes('user');

    // Default to whichever one exists
    let fillValue = credential.username || credential.email;

    // Override based on context clues
    if (wantsEmail && credential.email) {
      fillValue = credential.email;
    } else if (wantsUsername && credential.username) {
      fillValue = credential.username;
    }

    if (fillValue) {
      fillField(usernameField, fillValue);
      filled++;
    }
  }

  // Fill password if it exists on the screen
  if (passwordField && credential.password_secret) {
    fillField(passwordField, credential.password_secret);
    filled++;
  }

  return filled > 0;
}

function fillField(el, value) {
  el.focus();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (nativeInputValueSetter) nativeInputValueSetter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    el.offsetParent !== null
  );
}
