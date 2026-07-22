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
  sendToBackground(
    { type: 'CHECK_MATCHES', domain: window.location.hostname },
    (response) => {
      if (!response) return;

      if (response.success && response.matches.length > 0) {
        pageCredentials = response.matches[0];
        setupFocusListener();
        const { usernameField, passwordField } = getLoginFields();
        if (usernameField || passwordField)
          injectFloatingUI(usernameField || passwordField);
      }

      if (response.pendingCapture) {
        injectCapturePill(response.pendingCapture);
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

  // 🛡️ FIX 1: Changed to position: fixed and removed window scroll offsets
  activePill.style.cssText = `
    position: fixed;
    top: ${rect.bottom + 8}px;
    left: ${rect.left}px;
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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M3.043 0.00793814C2.67875 -0.0402392 2.33862 0.144477 2.30044 0.196644C2.26227 0.248811 1.93183 0.521439 2.0029 1.01486V12.004V22.9933L2.14131 23.2435C2.49875 23.8897 3.15581 24.1523 3.81468 23.9125C4.1043 23.8069 16.4213 11.5612 16.6263 11.1749C17.2416 10.0148 15.821 8.72086 14.7127 9.4318C14.2081 9.75558 12.4039 11.9134 12.0039 12.1134C11.9039 12.2134 11.3996 12.6718 11.3996 12.6718C10.8872 13.3827 8.79716 13.8649 7.68345 13.5293C7.19021 13.3805 6.39112 12.9737 6.33212 12.8413C6.32252 12.8193 6.28951 12.8013 6.25911 12.8013C6.1805 12.8013 5.63385 12.2274 5.44343 11.945C5.35542 11.8148 5.27142 11.696 5.25661 11.6814C4.84697 11.2749 4.55855 9.35161 4.80477 8.66826C4.84697 8.55107 4.88198 8.42508 4.88238 8.38849C4.88358 8.28669 5.20061 7.63794 5.38262 7.36496C5.61325 7.01899 5.49044 7.14538 9.1902 3.44207C11.0458 1.58461 12.5639 0.0509344 12.5639 0.0337357C12.5639 0.016537 10.4217 0.00354002 7.80347 0.0051399L3.043 0.00793814ZM11.6988 4.77137C7.32902 9.14203 7.41703 9.04223 7.42383 9.62179C7.43383 10.4673 8.01409 10.9841 8.88357 10.9219C9.37622 10.8865 9.40042 10.8671 11.2548 9.01904C12.1693 8.10751 12.935 7.36177 12.9564 7.36177C12.9776 7.36177 13.047 7.31357 13.1102 7.25458C13.2422 7.13159 14.0659 6.72182 14.1809 6.72182C14.2229 6.72182 14.3617 6.68502 14.4891 6.64002C15.3876 6.32305 17.1946 6.71662 17.9178 7.38696C17.9979 7.46116 18.0733 7.52175 18.0855 7.52175C18.1315 7.52175 18.4845 7.90093 18.4845 7.95012C18.4845 7.97852 18.5051 8.00172 18.5305 8.00172C18.5963 8.00172 18.9845 8.61627 19.1368 8.96164C19.6218 10.0612 19.5426 11.574 18.9487 12.5572C18.6567 13.0407 18.5153 13.1891 15.038 16.665C13.1492 18.5531 11.6038 20.112 11.6038 20.1292C11.6038 20.3588 14.2657 19.9804 15.3586 19.6104C16.2951 19.2934 18.2123 18.2657 18.2123 18.0809C18.3669 18.0809 20.1047 16.3131 20.1301 16.1523C20.2047 16.1131 20.7743 15.255 20.8985 15.0146C22.1461 12.6008 22.4661 10.3453 21.9166 7.84173C21.8222 7.41076 21.5656 6.58163 21.4466 6.32185C21.0689 5.49771 20.7537 4.89376 20.6313 4.76037C20.5947 4.72037 20.5647 4.66757 20.5647 4.64278C20.5647 4.59598 20.0298 3.85984 19.7786 3.56086C19.6026 3.35128 18.8361 2.58634 18.6169 2.40135C18.2677 2.10678 17.796 1.7622 17.7418 1.7622C17.7102 1.7622 17.6842 1.7442 17.684 1.72221C17.6834 1.64421 16.7281 1.11045 16.1445 0.862071L15.7676 0.701884L11.6988 4.77137Z" fill="#928EFE"/>
      </svg>
    </div>
    <div style="display: flex; flex-direction: column; min-width: 0;">
      <span style="font-size: 13px; font-weight: 600; line-height: 1;">Passave Vault</span>
      <span id="passave-autofill-id" style="font-size: 11px; color: #8888a0; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;"></span>
    </div>
  `;

  // Vault values are assigned as text, never interpolated into markup.
  activePill.querySelector('#passave-autofill-id').textContent =
    `Autofill • ${displayId}`;

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

  // 🛡️ FIX 2: Removed dangerous generic input[type="text"] fallback
  // Added id*="user" for better robust targeting
  const usernameSelectors = [
    'input[type="email"]',
    'input[type="text"][autocomplete*="email"]',
    'input[type="text"][autocomplete*="username"]',
    'input[type="text"][name*="email"]',
    'input[type="text"][name*="user"]',
    'input[type="text"][id*="user"]',
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
    // 🛡️ FIX 3: Include autocomplete in detection
    const autocompleteAttr = (
      usernameField.getAttribute('autocomplete') || ''
    ).toLowerCase();
    const str = (
      usernameField.name +
      ' ' +
      usernameField.id +
      ' ' +
      usernameField.placeholder +
      ' ' +
      usernameField.type +
      ' ' +
      autocompleteAttr
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

  // 🛡️ FIX 4: Add keydown/keyup events, and removed el.blur() to stop form jumps
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);

  // 🛡️ FIX 5: Allow fixed positioning for the visibility check
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  )
    return false;
  if (el.offsetParent === null && style.position !== 'fixed') return false;

  return true;
}

// ─── 6. CREDENTIAL CAPTURE (submit → background) ──────────────
let lastCaptureAt = 0;

function isIdentifierInput(el) {
  if (el.type === 'email' || el.type === 'tel') return true;
  return el.type === 'text';
}

function snapshotForm(root) {
  const inputs = Array.from(root.querySelectorAll('input')).filter(isVisible);
  const passwordValues = inputs
    .filter((el) => el.type === 'password')
    .map((el) => el.value);
  const identifierFields = inputs
    .filter((el) => el.type !== 'password' && isIdentifierInput(el))
    .map((el) => ({
      type: el.type,
      value: el.value,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      autocomplete: el.getAttribute('autocomplete') || '',
    }));
  return { identifierFields, passwordValues };
}

function handleCapture(root) {
  if (window.location.hostname.replace(/^www\./i, '') === 'passave.org') return;
  const now = Date.now();
  if (now - lastCaptureAt < 1000) return; // debounce submit + click double-fire
  const snap = snapshotForm(root);
  const { scenario, password } = PassaveCaptureCore.detectScenario(snap.passwordValues);
  if (!password) return;
  lastCaptureAt = now;
  const identifiers = PassaveCaptureCore.classifyIdentifiers(snap.identifierFields);
  sendToBackground(
    {
      type: 'CAPTURE_SUBMIT',
      domain: window.location.hostname,
      loginURL: window.location.origin + window.location.pathname,
      scenario,
      password,
      identifiers,
    },
    (response) => {
      // No response means the page navigated first; the load path re-serves it.
      if (response && response.pendingCapture) injectCapturePill(response.pendingCapture);
    },
  );
}

// Real form submits (capture phase runs before navigation).
document.addEventListener(
  'submit',
  (e) => {
    if (e.target instanceof HTMLFormElement) handleCapture(e.target);
  },
  true,
);

const SUBMIT_LABEL_RE =
  /sign\s?(in|up)|log\s?(in|on)|register|create|continue|next|submit|save|update|change|confirm|done/i;

function looksLikeSubmit(btn) {
  if (btn.type === 'submit') return true;
  const label = (
    btn.innerText ||
    btn.value ||
    btn.getAttribute('aria-label') ||
    ''
  ).trim();
  return !!label && SUBMIT_LABEL_RE.test(label);
}

// SPA fallback for forms that never navigate. Deliberately narrow: a
// submit-looking control, and a password the user has actually typed —
// otherwise every "show password" toggle and menu button snapshots the page.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest(
      'button, input[type="submit"], input[type="button"], [role="button"]',
    );
    if (!btn || !looksLikeSubmit(btn)) return;

    const filledPassword = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ).some((el) => el.value && isVisible(el));
    if (!filledPassword) return;

    handleCapture(btn.closest('form') || document);
  },
  true,
);

// ─── 7. CAPTURE PILL UI ───────────────────────────────────────
// The pill renders inside a shadow root. Injected into the page's own DOM it
// inherited whatever the site declared for `button`, `input` and body text —
// which is why it looked right on some sites and burst its border on others.
// A shadow root plus `all: initial` on the host is the only reliable way to
// keep the vault's own typography.

const PASSAVE_SANS = "'PassaveDMSans', system-ui, -apple-system, sans-serif";
const PASSAVE_DISPLAY = "'PassaveSyne', 'PassaveDMSans', system-ui, sans-serif";

// @font-face has to live in the document — font faces are document-scoped and
// then visible to every shadow tree inside it.
function ensurePassaveFonts() {
  if (document.getElementById('passave-fontfaces')) return;
  let sans, display;
  try {
    sans = chrome.runtime.getURL('fonts/DMSans-Regular.ttf');
    display = chrome.runtime.getURL('fonts/Syne-Bold.ttf');
  } catch {
    return; // extension context gone; the fallback stack still renders
  }
  const style = document.createElement('style');
  style.id = 'passave-fontfaces';
  style.textContent = `
    @font-face {
      font-family: 'PassaveDMSans';
      src: url('${sans}') format('truetype');
      font-weight: 400; font-style: normal; font-display: swap;
    }
    @font-face {
      font-family: 'PassaveSyne';
      src: url('${display}') format('truetype');
      font-weight: 700; font-style: normal; font-display: swap;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function capturePillStyles() {
  return `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    .card {
      width: 320px;
      max-width: calc(100vw - 48px);
      background: #13131a;
      border: 1px solid rgba(124, 106, 247, 0.3);
      border-radius: 14px;
      padding: 16px;
      color: #f0f0f5;
      font-family: ${PASSAVE_SANS};
      font-size: 13px;
      font-weight: 400;
      line-height: 1.5;
      letter-spacing: normal;
      text-align: left;
      text-transform: none;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      -webkit-font-smoothing: antialiased;
      animation: passavePop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .head { display: flex; align-items: flex-start; gap: 10px; }
    .mark {
      flex: 0 0 auto;
      width: 28px; height: 28px;
      border-radius: 8px;
      background: rgba(124, 106, 247, 0.12);
      display: flex; align-items: center; justify-content: center;
    }
    .headings { min-width: 0; flex: 1 1 auto; }
    .close {
      flex: 0 0 auto;
      background: transparent;
      color: #555568;
      font-size: 16px;
      line-height: 1;
      padding: 2px 4px;
      margin: -2px -4px 0 0;
    }
    .close:hover { color: #f0f0f5; }
    .title {
      font-family: ${PASSAVE_DISPLAY};
      font-weight: 700;
      font-size: 14px;
      line-height: 1.25;
    }
    .subtitle {
      margin-top: 3px;
      font-size: 12px;
      color: #8888a0;
      overflow-wrap: anywhere;
    }

    .edit { display: none; flex-direction: column; gap: 8px; margin-top: 12px; }
    .edit.open { display: flex; }
    input {
      display: block;
      width: 100%;
      background: #1a1a24;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 9px 11px;
      color: #f0f0f5;
      font-family: ${PASSAVE_SANS};
      font-size: 12px;
      line-height: 1.4;
      outline: none;
    }
    input::placeholder { color: #555568; }
    input:focus { border-color: #7c6af7; }

    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    button {
      font-family: ${PASSAVE_SANS};
      border: none;
      border-radius: 8px;
      cursor: pointer;
      line-height: 1;
      text-transform: none;
      letter-spacing: normal;
      white-space: nowrap;
    }
    .primary {
      background: #7c6af7;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      padding: 10px 18px;
    }
    .primary:hover { background: #9d8fff; }
    .ghost {
      background: transparent;
      color: #8888a0;
      font-size: 12px;
      padding: 10px 2px;
    }
    .ghost:hover { color: #f0f0f5; }
    .never { margin-left: auto; }

    .status { margin-top: 10px; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .status.ok { color: #50d890; }
    .status.err { color: #f05f5f; }
    .status:empty { display: none; }

    @keyframes passavePop {
      from { transform: translateY(8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `;
}

function captureErrorText(res) {
  if (!res) return 'Passave is not responding — reload the page';
  if (res.message) return res.message;
  switch (res.error) {
    case 'stale':
      return 'This prompt expired — submit the form again';
    case 'unauthorized':
    case 'http_401':
    case 'http_403':
      return 'Open Passave and sign in, then try again';
    case 'network':
      return 'Could not reach Passave — check your connection';
    default:
      return 'Passave could not save this';
  }
}

function injectCapturePill(pending) {
  const existing = document.getElementById('passave-capture-pill');
  if (existing) existing.remove();
  ensurePassaveFonts();

  const isUpdate = pending.action === 'update';

  const host = document.createElement('div');
  host.id = 'passave-capture-pill';
  host.style.cssText = `
    all: initial !important;
    display: block !important;
    position: fixed !important;
    inset: auto 24px 24px auto !important;
    z-index: 2147483647 !important;
  `;
  const shadow = host.attachShadow({ mode: 'open' });

  // Static structure only — every page-derived value is assigned as text or as
  // a property below, so nothing user-controlled is ever parsed as markup.
  shadow.innerHTML = `
    <style>${capturePillStyles()}</style>
    <div class="card">
      <div class="head">
        <div class="mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M3.043 0.00793814C2.67875 -0.0402392 2.33862 0.144477 2.30044 0.196644C2.26227 0.248811 1.93183 0.521439 2.0029 1.01486V12.004V22.9933L2.14131 23.2435C2.49875 23.8897 3.15581 24.1523 3.81468 23.9125C4.1043 23.8069 16.4213 11.5612 16.6263 11.1749C17.2416 10.0148 15.821 8.72086 14.7127 9.4318C14.2081 9.75558 12.4039 11.9134 12.0039 12.1134C11.9039 12.2134 11.3996 12.6718 11.3996 12.6718C10.8872 13.3827 8.79716 13.8649 7.68345 13.5293C7.19021 13.3805 6.39112 12.9737 6.33212 12.8413C6.32252 12.8193 6.28951 12.8013 6.25911 12.8013C6.1805 12.8013 5.63385 12.2274 5.44343 11.945C5.35542 11.8148 5.27142 11.696 5.25661 11.6814C4.84697 11.2749 4.55855 9.35161 4.80477 8.66826C4.84697 8.55107 4.88198 8.42508 4.88238 8.38849C4.88358 8.28669 5.20061 7.63794 5.38262 7.36496C5.61325 7.01899 5.49044 7.14538 9.1902 3.44207C11.0458 1.58461 12.5639 0.0509344 12.5639 0.0337357C12.5639 0.016537 10.4217 0.00354002 7.80347 0.0051399L3.043 0.00793814ZM11.6988 4.77137C7.32902 9.14203 7.41703 9.04223 7.42383 9.62179C7.43383 10.4673 8.01409 10.9841 8.88357 10.9219C9.37622 10.8865 9.40042 10.8671 11.2548 9.01904C12.1693 8.10751 12.935 7.36177 12.9564 7.36177C12.9776 7.36177 13.047 7.31357 13.1102 7.25458C13.2422 7.13159 14.0659 6.72182 14.1809 6.72182C14.2229 6.72182 14.3617 6.68502 14.4891 6.64002C15.3876 6.32305 17.1946 6.71662 17.9178 7.38696C17.9979 7.46116 18.0733 7.52175 18.0855 7.52175C18.1315 7.52175 18.4845 7.90093 18.4845 7.95012C18.4845 7.97852 18.5051 8.00172 18.5305 8.00172C18.5963 8.00172 18.9845 8.61627 19.1368 8.96164C19.6218 10.0612 19.5426 11.574 18.9487 12.5572C18.6567 13.0407 18.5153 13.1891 15.038 16.665C13.1492 18.5531 11.6038 20.112 11.6038 20.1292C11.6038 20.3588 14.2657 19.9804 15.3586 19.6104C16.2951 19.2934 18.2123 18.2657 18.2123 18.0809C18.3669 18.0809 20.1047 16.3131 20.1301 16.1523C20.2047 16.1131 20.7743 15.255 20.8985 15.0146C22.1461 12.6008 22.4661 10.3453 21.9166 7.84173C21.8222 7.41076 21.5656 6.58163 21.4466 6.32185C21.0689 5.49771 20.7537 4.89376 20.6313 4.76037C20.5947 4.72037 20.5647 4.66757 20.5647 4.64278C20.5647 4.59598 20.0298 3.85984 19.7786 3.56086C19.6026 3.35128 18.8361 2.58634 18.6169 2.40135C18.2677 2.10678 17.796 1.7622 17.7418 1.7622C17.7102 1.7622 17.6842 1.7442 17.684 1.72221C17.6834 1.64421 16.7281 1.11045 16.1445 0.862071L15.7676 0.701884L11.6988 4.77137Z" fill="#928EFE"/>
          </svg>
        </div>
        <div class="headings">
          <div class="title"></div>
          <div class="subtitle"></div>
        </div>
        <button class="close" aria-label="Dismiss">&times;</button>
      </div>
      <div class="edit">
        <input class="f-name" placeholder="Name" />
        <input class="f-username" placeholder="Username" />
        <input class="f-email" placeholder="Email" />
      </div>
      <div class="status" role="status"></div>
      <div class="actions">
        <button class="primary"></button>
        <button class="ghost toggle">Edit</button>
        <button class="ghost never">Never for this site</button>
      </div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const editBox = $('.edit');
  const status = $('.status');
  const saveBtn = $('.primary');

  $('.title').textContent = isUpdate
    ? 'Update password in Passave?'
    : 'Save to Passave?';
  $('.subtitle').textContent =
    pending.username || pending.email || pending.name || pending.domain;
  $('.f-name').value = pending.name || '';
  $('.f-username').value = pending.username || '';
  $('.f-email').value = pending.email || '';
  saveBtn.textContent = isUpdate ? 'Update' : 'Save';

  document.body.appendChild(host);

  $('.toggle').addEventListener('click', () => {
    editBox.classList.toggle('open');
  });

  $('.close').addEventListener('click', () => {
    sendToBackground({ type: 'DISMISS_CAPTURE' });
    host.remove();
  });

  $('.never').addEventListener('click', () => {
    sendToBackground({ type: 'IGNORE_SITE', domain: pending.domain });
    host.remove();
  });

  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    status.className = 'status';
    status.textContent = isUpdate ? 'Updating…' : 'Saving…';

    const edits = {
      name: $('.f-name').value,
      username: $('.f-username').value,
      email: $('.f-email').value,
    };

    sendToBackground({ type: 'SAVE_CREDENTIAL', nonce: pending.nonce, edits }, (res) => {
      if (res && res.success) {
        status.className = 'status ok';
        status.textContent = isUpdate ? 'Updated in your vault' : 'Saved to your vault';
        setTimeout(() => host.remove(), 1600);
        return;
      }
      // Keep the prompt open on failure so the answer isn't lost to a retry.
      status.className = 'status err';
      status.textContent = captureErrorText(res);
      saveBtn.disabled = false;
    });
  });
}

// chrome.runtime throws outright once the extension is reloaded or updated
// underneath a page that still has this script running.
function sendToBackground(message, callback) {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        if (callback) callback(null);
        return;
      }
      if (callback) callback(response);
    });
  } catch {
    if (callback) callback(null);
  }
}
