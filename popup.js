/**
 * PASSAVE EXTENSION — popup.js
 * Smart-fill enabled.
 */

const API = 'https://passave.org/api/v1';

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

  chrome.storage.local.get(['token', 'username'], ({ token, username }) => {
    if (token) {
      showVault(username);
      fetchSaves(token);
    } else {
      showLogin();
    }
  });

  bindEvents();
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
      openDetail(matches[0]);
    } else if (matches.length > 1) {
      // show filtered list
      searchInput.value = domain;
      renderSaves(matches);
    } else {
      showToast('No match for this page', 'error');
    }
  });

  // Detail autofill button
  detailAutofill.addEventListener('click', () => {
    if (!currentSave || !currentTab) return;
    chrome.tabs.sendMessage(
      currentTab.id,
      {
        type: 'AUTOFILL',
        // 🎯 THE FIX: Send the entire save object so content.js can parse email vs username
        data: currentSave,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          showToast('Could not autofill — try refreshing the page', 'error');
        } else {
          showToast('Autofilled!', 'success');
          closeDetail();
        }
      },
    );
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

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password, otp }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showError(data.message || 'Login failed. Check your credentials.');
      setLoginLoading(false);
      return;
    }

    const token = data.token;
    if (!token) {
      showError('Authentication failed: No secure token received from server.');
      setLoginLoading(false);
      return;
    }

    const username = data.user?.username || email.split('@')[0];

    chrome.storage.local.set({ token, username }, () => {
      setLoginLoading(false);
      showVault(username);
      fetchSaves(token);
    });
  } catch (err) {
    showError('Network error — check your connection.');
    setLoginLoading(false);
  }
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
function handleLogout() {
  chrome.storage.local.remove(['token', 'username'], () => {
    allSaves = [];
    currentSave = null;
    loginForm.reset();
    closeDetail();
    showLogin();
  });
}

// ─── FETCH SAVES ─────────────────────────────────────────────
async function fetchSaves(token) {
  savesList.innerHTML = `
    <div class="loading-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>Decrypting vault…</p>
    </div>`;

  try {
    const res = await fetch(`${API}/save/all`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (res.status === 401 || res.status === 403) {
      handleLogout();
      return;
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    allSaves = data.saves || [];
    vaultCount.textContent = allSaves.length;
    renderSaves(allSaves);
    checkPageMatch();
  } catch (err) {
    handleLogout();
    showError('Session expired or could not connect to vault.');
  }
}

// ─── RENDER ──────────────────────────────────────────────────
function renderSaves(saves) {
  if (!saves.length) {
    savesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
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
      const logoHtml =
        save.logoURL && !save.logoURL.includes('credit-card-placeholder')
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
  if (save.logoURL && !save.logoURL.includes('placeholder')) {
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

  if (save.loginURL) {
    detailOpenUrl.href = save.loginURL;
    detailOpenUrl.style.display = 'flex';
  } else {
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
function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
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
    ).hostname.replace('www.', '');
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
