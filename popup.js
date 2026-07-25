/**
 * PASSAVE EXTENSION — popup.js
 * Smart-fill enabled.
 */

// ─── DOM refs ───────────────────────────────────────────────
const screenLogin = document.getElementById('screen-login');
const screenVault = document.getElementById('screen-vault');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginOtp = document.getElementById('login-otp');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const savesList = document.getElementById('saves-list');
const vaultCount = document.getElementById('vault-count');
const greetingName = document.getElementById('user-greeting');
const greetingTime = document.getElementById('greeting-time');
const detailPanel = document.getElementById('panel-detail');
const detailBack = document.getElementById('detail-back');
const detailName = document.getElementById('detail-name');
const detailCat = document.getElementById('detail-category');
const detailFields = document.getElementById('detail-fields');
const detailLogo = document.getElementById('detail-logo');
const detailLogoFb = document.getElementById('detail-logo-fallback');
const detailAutofill = document.getElementById('detail-autofill');
const detailOpenUrl = document.getElementById('detail-open-url');
const pageMatchBanner = document.getElementById('page-match-banner');
const pageMatchText = document.getElementById('page-match-text');
const revealPwBtn = document.getElementById('reveal-password');
const autofillPageBtn = document.getElementById('autofill-page-btn');

let allSaves = [];
let currentSave = null;
let currentTab = null;

// ─── INIT ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setGreeting();
  await getCurrentTab();

  // bindEvents() must run no matter what happens below — a dead worker
  // connection must not leave every listener in the popup unbound.
  bindEvents();

  // Tokens live in the service worker. The popup only ever asks.
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'AUTH_STATE' });
  } catch {
    // Can't reach the worker to learn state — sign-in is the safe default
    // and self-corrects the next time the popup opens.
    showLogin();
    return;
  }

  if (state && state.signedIn) {
    showVault(state.username);
    fetchSaves();
  } else {
    showLogin();
  }
});

// ─── GREETING ────────────────────────────────────────────────
function setGreeting() {
  const h = new Date().getHours();
  greetingTime.textContent =
    h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

// ─── GET CURRENT TAB ─────────────────────────────────────────
let isRestrictedPage = false;

async function getCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    currentTab = tab;

    // CRITICAL FIX: Detect if Chrome forbids scripts on this page
    const restrictedPrefixes = [
      'chrome://',
      'edge://',
      'about:',
      'chrome-extension://',
      'https://chrome.google.com/webstore',
    ];
    isRestrictedPage = restrictedPrefixes.some((prefix) =>
      tab.url.startsWith(prefix),
    );

    // Visually disable the autofill button if the page is restricted
    if (isRestrictedPage) {
      autofillPageBtn.style.opacity = '0.3';
      autofillPageBtn.style.cursor = 'not-allowed';
      autofillPageBtn.title = 'Cannot autofill on system pages';
    }
  } catch {}
}

// ─── SCREENS ─────────────────────────────────────────────────
function showLogin() {
  screenLogin.classList.add('active');
  screenVault.classList.remove('active');
}
function showVault(username) {
  screenVault.classList.add('active');
  screenLogin.classList.remove('active');
  if (username) greetingName.textContent = username;
}

// ─── EVENTS ──────────────────────────────────────────────────
function bindEvents() {
  // Login
  loginForm.addEventListener('submit', handleLogin);

  // Reveal password
  revealPwBtn.addEventListener('click', () => {
    const isText = loginPassword.type === 'text';
    loginPassword.type = isText ? 'password' : 'text';
    revealPwBtn.innerHTML = isText
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  });

  // OTP — auto format
  loginOtp.addEventListener('input', () => {
    loginOtp.value = loginOtp.value.replace(/\D/g, '').slice(0, 6);
  });

  // Logout
  logoutBtn.addEventListener('click', handleLogout);

  // Search
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.style.display = q ? 'flex' : 'none';
    renderSaves(filterSaves(q));
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    renderSaves(allSaves);
  });

  // Detail panel back
  detailBack.addEventListener('click', closeDetail);

  // Autofill current page button (header)
  autofillPageBtn.addEventListener('click', () => {
    if (!currentTab) return;

    // CRITICAL FIX: Stop execution if on a restricted page
    if (isRestrictedPage) {
      showToast('Passave cannot modify system pages', 'error');
      return;
    }

    const domain = extractDomain(currentTab.url);
    const matches = allSaves.filter(
      (s) => s.loginURL && extractDomain(s.loginURL) === domain,
    );

    if (matches.length === 1) {
      // 🛡️ FIX: Autofill immediately if there's only 1 match
      quickAutofill(matches[0]);
    } else if (matches.length > 1) {
      // show filtered list
      searchInput.value = domain;
      searchClear.style.display = 'flex';
      renderSaves(matches);
    } else {
      showToast('No match for this page', 'error');
    }
  });

  // Detail autofill button
  detailAutofill.addEventListener('click', () => {
    if (!currentSave || !currentTab) return;
    quickAutofill(currentSave); // Reused the helper to keep logic DRY
    closeDetail();
  });
}

// ─── LOGIN ────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  setLoginLoading(true);
  hideError();

  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  const otp = loginOtp.value.trim();

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'AUTH_LOGIN',
      credentials: { email, password, otp },
    });
  } catch {
    setLoginLoading(false);
    showError('Could not reach the extension service — try reopening the popup.');
    return;
  }

  setLoginLoading(false);

  if (!result || !result.success) {
    showError((result && result.message) || 'Login failed. Check your credentials.');
    return;
  }

  showVault(result.username);
  fetchSaves();
}

function setLoginLoading(loading) {
  if (loading) {
    loginBtn.disabled = true;
    loginBtn.innerHTML = `<span class="btn-spinner"></span>`;
  } else {
    loginBtn.disabled = false;
    loginBtn.innerHTML = `<span class="btn-text">Unlock Vault</span><span class="btn-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span>`;
  }
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.style.display = 'block';
}
function hideError() {
  loginError.style.display = 'none';
}

// ─── LOGOUT ──────────────────────────────────────────────────
async function handleLogout() {
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' });
  } catch {
    result = null;
  }

  // Either the message never reached the worker, or the worker failed to clear
  // storage. Both mean the credentials are still on disk, so showing the
  // sign-in screen would claim a sign-out that didn't happen — and the user
  // would flip back to the vault on the next open. Tell the truth instead.
  if (!result || !result.success) {
    showToast('Could not sign out — please try again', 'error');
    return;
  }

  resetToLogin();
}

function resetToLogin() {
  allSaves = [];
  currentSave = null;
  loginForm.reset();
  closeDetail();

  // 🛡️ FIX: Hide banner if it was open during logout
  if (pageMatchBanner) pageMatchBanner.style.display = 'none';

  showLogin();
}

// ─── FETCH SAVES ─────────────────────────────────────────────
async function fetchSaves() {
  savesList.innerHTML = `
    <div class="loading-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>Decrypting vault…</p>
    </div>`;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'VAULT_FETCH' });
  } catch {
    // A messaging failure says nothing about the session — fall through to
    // the generic failure branch below rather than signing the user out.
    res = null;
  }

  if (!res || !res.success) {
    // Only a real token failure returns to the sign-in screen. A rate limit or
    // a dead network leaves a valid 30-day session in place — throwing it away
    // over a transient condition is the expensive mistake here.
    if (res && res.reason === 'signed_out') {
      showToast('Session ended — please sign in again.', 'error');
      resetToLogin();
      return;
    }

    const message =
      res && res.reason === 'network_unavailable'
        ? "Can't reach Passave right now — try again in a moment."
        : 'Could not reach vault — check your connection.';
    showToast(message, 'error');
    savesList.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--danger)">${escapeHtml(message)}</p>
      </div>`;
    return;
  }

  allSaves = res.saves || [];
  vaultCount.textContent = allSaves.length;
  renderSaves(allSaves);
  checkPageMatch();
}

// ─── RENDER ──────────────────────────────────────────────────
function renderSaves(saves) {
  if (!saves.length) {
    savesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M3.043 0.00793814C2.67875 -0.0402392 2.33862 0.144477 2.30044 0.196644C2.26227 0.248811 1.93183 0.521439 2.0029 1.01486V12.004V22.9933L2.14131 23.2435C2.49875 23.8897 3.15581 24.1523 3.81468 23.9125C4.1043 23.8069 16.4213 11.5612 16.6263 11.1749C17.2416 10.0148 15.821 8.72086 14.7127 9.4318C14.2081 9.75558 12.4039 11.9134 12.0039 12.1134C11.9039 12.2134 11.3996 12.6718 11.3996 12.6718C10.8872 13.3827 8.79716 13.8649 7.68345 13.5293C7.19021 13.3805 6.39112 12.9737 6.33212 12.8413C6.32252 12.8193 6.28951 12.8013 6.25911 12.8013C6.1805 12.8013 5.63385 12.2274 5.44343 11.945C5.35542 11.8148 5.27142 11.696 5.25661 11.6814C4.84697 11.2749 4.55855 9.35161 4.80477 8.66826C4.84697 8.55107 4.88198 8.42508 4.88238 8.38849C4.88358 8.28669 5.20061 7.63794 5.38262 7.36496C5.61325 7.01899 5.49044 7.14538 9.1902 3.44207C11.0458 1.58461 12.5639 0.0509344 12.5639 0.0337357C12.5639 0.016537 10.4217 0.00354002 7.80347 0.0051399L3.043 0.00793814ZM11.6988 4.77137C7.32902 9.14203 7.41703 9.04223 7.42383 9.62179C7.43383 10.4673 8.01409 10.9841 8.88357 10.9219C9.37622 10.8865 9.40042 10.8671 11.2548 9.01904C12.1693 8.10751 12.935 7.36177 12.9564 7.36177C12.9776 7.36177 13.047 7.31357 13.1102 7.25458C13.2422 7.13159 14.0659 6.72182 14.1809 6.72182C14.2229 6.72182 14.3617 6.68502 14.4891 6.64002C15.3876 6.32305 17.1946 6.71662 17.9178 7.38696C17.9979 7.46116 18.0733 7.52175 18.0855 7.52175C18.1315 7.52175 18.4845 7.90093 18.4845 7.95012C18.4845 7.97852 18.5051 8.00172 18.5305 8.00172C18.5963 8.00172 18.9845 8.61627 19.1368 8.96164C19.6218 10.0612 19.5426 11.574 18.9487 12.5572C18.6567 13.0407 18.5153 13.1891 15.038 16.665C13.1492 18.5531 11.6038 20.112 11.6038 20.1292C11.6038 20.3588 14.2657 19.9804 15.3586 19.6104C16.2951 19.2934 18.2123 18.2657 18.2123 18.0809C18.3669 18.0809 20.1047 16.3131 20.1301 16.1523C20.2047 16.1131 20.7743 15.255 20.8985 15.0146C22.1461 12.6008 22.4661 10.3453 21.9166 7.84173C21.8222 7.41076 21.5656 6.58163 21.4466 6.32185C21.0689 5.49771 20.7537 4.89376 20.6313 4.76037C20.5947 4.72037 20.5647 4.66757 20.5647 4.64278C20.5647 4.59598 20.0298 3.85984 19.7786 3.56086C19.6026 3.35128 18.8361 2.58634 18.6169 2.40135C18.2677 2.10678 17.796 1.7622 17.7418 1.7622C17.7102 1.7622 17.6842 1.7442 17.684 1.72221C17.6834 1.64421 16.7281 1.11045 16.1445 0.862071L15.7676 0.701884L11.6988 4.77137Z" fill="#928EFE"/>
          </svg>
        </div>
        <h3>Vault is empty</h3>
        <p>Add credentials from the Passave web app.</p>
      </div>`;
    return;
  }

  const groups = {};
  saves.forEach((s) => {
    const cat = s.category || 'Other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  });

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    if (Object.keys(groups).length > 1) {
      html += `<div class="list-section-label">${escapeHtml(cat)}</div>`;
    }
    items.forEach((save) => {
      const initial = (save.name || '?')[0].toUpperCase();

      // 🛡️ FIX: Use centralized logo validation helper
      const logoHtml = isRealLogo(save.logoURL)
        ? `<img src="${escapeHtml(save.logoURL)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
      const fallbackDisplay = logoHtml ? 'none' : 'flex';

      html += `
        <div class="save-card" data-id="${escapeHtml(save._id)}">
          <div class="save-logo">
            ${logoHtml}
            <span style="display:${fallbackDisplay}">${initial}</span>
          </div>
          <div class="save-info">
            <div class="save-name">${escapeHtml(save.name || 'Unnamed')}</div>
            <div class="save-meta">${escapeHtml(save.username || save.email || save.loginURL || '')}</div>
          </div>
          <div class="save-actions">
            <button class="save-action-btn copy-btn" data-id="${escapeHtml(save._id)}" title="Copy password">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="save-action-btn fill-btn" data-id="${escapeHtml(save._id)}" title="Autofill">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
          </div>
        </div>`;
    });
  }

  savesList.innerHTML = html;

  savesList.querySelectorAll('.save-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.save-actions')) return;
      const save = allSaves.find((s) => s._id === card.dataset.id);
      if (save) openDetail(save);
    });
  });

  savesList.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const save = allSaves.find((s) => s._id === btn.dataset.id);
      if (save?.password_secret) {
        copyToClipboard(save.password_secret);
        showToast('Password copied', 'success');
      }
    });
  });

  savesList.querySelectorAll('.fill-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const save = allSaves.find((s) => s._id === btn.dataset.id);
      if (save) quickAutofill(save);
    });
  });
}

// ─── SEARCH ──────────────────────────────────────────────────
function filterSaves(q) {
  if (!q) return allSaves;
  const lq = q.toLowerCase();
  return allSaves.filter(
    (s) =>
      (s.name || '').toLowerCase().includes(lq) ||
      (s.username || '').toLowerCase().includes(lq) ||
      (s.email || '').toLowerCase().includes(lq) ||
      (s.loginURL || '').toLowerCase().includes(lq) ||
      (s.category || '').toLowerCase().includes(lq),
  );
}

// ─── PAGE MATCH ──────────────────────────────────────────────
function checkPageMatch() {
  if (!currentTab?.url) return;
  const domain = extractDomain(currentTab.url);
  const matches = allSaves.filter(
    (s) => s.loginURL && extractDomain(s.loginURL) === domain,
  );
  if (matches.length > 0) {
    pageMatchBanner.style.display = 'block';
    pageMatchText.textContent = `${matches.length} match${matches.length > 1 ? 'es' : ''} for ${domain}`;
  }
}

// ─── DETAIL PANEL ─────────────────────────────────────────────
function openDetail(save) {
  currentSave = save;
  detailName.textContent = save.name || 'Unnamed';

  if (save.category) {
    detailCat.textContent = save.category;
    detailCat.style.display = 'inline-block';
  } else {
    detailCat.style.display = 'none';
  }

  const initial = (save.name || '?')[0].toUpperCase();
  detailLogoFb.textContent = initial;

  // 🛡️ FIX: Use centralized logo validation
  if (isRealLogo(save.logoURL)) {
    detailLogo.src = save.logoURL;
    detailLogo.style.display = 'block';
    detailLogoFb.style.display = 'none';
  } else {
    detailLogo.style.display = 'none';
    detailLogoFb.style.display = 'flex';
  }

  const fields = [];
  if (save.username)
    fields.push({ label: 'Username', value: save.username, secret: false });
  if (save.email)
    fields.push({ label: 'Email', value: save.email, secret: false });
  if (save.password_secret)
    fields.push({
      label: 'Password',
      value: save.password_secret,
      secret: true,
    });
  if (save.registered_number)
    fields.push({
      label: 'Reg. Number',
      value: save.registered_number,
      secret: true,
    });
  if (save.loginURL)
    fields.push({ label: 'URL', value: save.loginURL, secret: false });

  detailFields.innerHTML = fields
    .map(
      (f, i) => `
    <div class="detail-field">
      <span class="detail-field-label">${escapeHtml(f.label)}</span>
      <div class="detail-field-row">
        <span class="detail-field-value ${f.secret ? 'secret' : ''}" data-field="${i}">${escapeHtml(f.value)}</span>
        <button class="copy-field-btn" data-field="${i}" title="Copy">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
    </div>`,
    )
    .join('');

  detailFields.querySelectorAll('.detail-field-value.secret').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('revealed'));
  });

  detailFields.querySelectorAll('.copy-field-btn').forEach((btn) => {
    const idx = parseInt(btn.dataset.field);
    btn.addEventListener('click', () => {
      copyToClipboard(fields[idx].value);
      showToast(`${fields[idx].label} copied`, 'success');
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    });
  });

  // 🛡️ FIX: Validate protocol to prevent javascript: URI attacks (XSS)
  if (save.loginURL && /^https?:\/\//i.test(save.loginURL)) {
    detailOpenUrl.href = save.loginURL;
    detailOpenUrl.style.display = 'flex';
  } else {
    detailOpenUrl.removeAttribute('href');
    detailOpenUrl.style.display = 'none';
  }

  detailPanel.classList.add('open');
}

function closeDetail() {
  detailPanel.classList.remove('open');
  currentSave = null;
}

// ─── AUTOFILL ────────────────────────────────────────────────
function quickAutofill(save) {
  if (!currentTab) {
    showToast('No active tab', 'error');
    return;
  }
  chrome.tabs.sendMessage(
    currentTab.id,
    {
      type: 'AUTOFILL',
      // 🎯 THE FIX: Send the entire save object here too
      data: save,
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        showToast('Could not autofill — try refreshing the page', 'error');
      } else {
        showToast('Autofilled!', 'success');
      }
    },
  );
}

// ─── UTILS ───────────────────────────────────────────────────

// 🛡️ FIX: Centralized logo validation helper
const isRealLogo = (url) => url && !url.includes('placeholder');

// 🛡️ FIX: Modernized clipboard logic, dropped execCommand fallback
function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch((err) => {
    console.error('Copy failed', err);
  });
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.style.display = 'none';
    }, 200);
  }, 2200);
}

function extractDomain(url) {
  if (!url) return '';
  try {
    return new URL(
      url.startsWith('http') ? url : 'https://' + url,
    ).hostname.replace(/^www\./i, ''); // 🛡️ FIX: Match regex from background.js
  } catch {
    return url;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
