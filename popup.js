const BASE_URL = 'https://passave.org';

document.addEventListener('DOMContentLoaded', function () {
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');

  // --- THEME ENGINE ---
  chrome.storage.local.get(['theme'], (result) => {
    if (result.theme === 'light') {
      document.body.classList.add('light-mode');
      themeIcon.textContent = '☀️';
    }
  });

  themeToggle.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light-mode');
    themeIcon.textContent = isLight ? '☀️' : '🌙';
    chrome.storage.local.set({ theme: isLight ? 'light' : 'dark' });
  });

  const loginSection = document.getElementById('login-section');
  const vaultSection = document.getElementById('vault-section');
  const loginForm = document.getElementById('login-form');
  const messageDiv = document.getElementById('message');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const savesList = document.getElementById('saves-list');
  const searchInput = document.getElementById('search-input');

  // 1. Check if the user is already logged in
  chrome.storage.local.get(['token'], function (result) {
    if (result.token) {
      showVault(result.token);
    }
  });

  // 2. Handle Login
  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const secret_token = document.getElementById('secret_token').value;

    loginBtn.textContent = 'Decrypting...';
    messageDiv.textContent = '';
    messageDiv.className = '';

    try {
      const response = await fetch(`${BASE_URL}/auth/ext-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, secret_token }),
      });

      const data = await response.json();

      if (response.ok) {
        chrome.storage.local.set({ token: data.token }, function () {
          showVault(data.token);
        });
      } else {
        messageDiv.textContent = data.error || data.message || 'Login failed.';
        messageDiv.className = 'error';
        loginBtn.textContent = 'Unlock Vault';
      }
    } catch (error) {
      console.error('Fetch error:', error);
      messageDiv.textContent =
        'Could not connect to server. Check your connection.';
      messageDiv.className = 'error';
      loginBtn.textContent = 'Unlock Vault';
    }
  });

  // 3. Handle Logout
  logoutBtn.addEventListener('click', function () {
    chrome.storage.local.remove(['token', 'vault'], function () {
      vaultSection.style.display = 'none';
      loginSection.style.display = 'block';
      logoutBtn.style.display = 'none';
      loginForm.reset();
      loginBtn.textContent = 'Unlock Vault';
      messageDiv.textContent = '';
      searchInput.value = '';
    });
  });

  // 4. Show the Vault
  async function showVault(token) {
    loginSection.style.display = 'none';
    vaultSection.style.display = 'block';
    logoutBtn.style.display = 'block';

    try {
      const response = await fetch(`${BASE_URL}/profile/dashboard`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (response.ok && data.user && data.user.saves) {
        chrome.storage.local.set({ vault: data.user.saves });

        let html = '';
        data.user.saves.forEach((save) => {
          let finalLogoUrl = save.logoURL;
          if (!finalLogoUrl || finalLogoUrl.includes('clearbit.com')) {
            try {
              const extractedDomain = new URL(save.loginURL).hostname.replace(
                /^www\./,
                '',
              );
              finalLogoUrl = `https://www.google.com/s2/favicons?domain=${extractedDomain}&sz=64`;
            } catch (e) {
              finalLogoUrl = '';
            }
          }

          const logoHtml = finalLogoUrl
            ? `<img src="${finalLogoUrl}" style="width: 20px; height: 20px; object-fit: contain;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
                           <span style="display:none; color: #9ca3af; font-size: 14px;">🔑</span>`
            : `<span style="color: #9ca3af; font-size: 14px;">🔑</span>`;

          html += `
              <div class="save-card" style="display: flex; align-items: center;">
                  <div style="width: 36px; height: 36px; margin-right: 12px; flex-shrink: 0; background-color: var(--bg-main); border: 1px solid var(--border); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                      ${logoHtml}
                  </div>
                  <div style="flex-grow: 1;">
                      <span class="save-title">${save.name}</span>
                      <div class="save-detail" style="margin-bottom: 4px;">User: <strong style="margin-left: 4px; color: var(--text-header);">${save.username}</strong></div>
                      <div class="save-detail" style="margin-bottom: 0;">Pass: 
                          <span class="badge-copy copy-pass-btn" data-password="${save.password_secret}" title="Click to copy">••••••••</span>
                          <button class="badge-autofill autofill-btn" data-username="${save.username}" data-password="${save.password_secret}">Autofill</button>
                      </div>
                  </div>
              </div>
          `;
        });

        if (data.user.saves.length === 0) {
          html = '<p class="empty-state">No credentials found.</p>';
        }

        savesList.innerHTML = html;

        // Attach Copy Events
        const copyBtns = savesList.querySelectorAll('.copy-pass-btn');
        copyBtns.forEach((btn) => {
          btn.addEventListener('click', function () {
            const passwordToCopy = this.getAttribute('data-password');
            navigator.clipboard.writeText(passwordToCopy).then(() => {
              const originalText = this.textContent;
              this.textContent = 'Copied!';
              this.style.backgroundColor = '#10b981'; /* Teal */
              this.style.color = '#111827';
              setTimeout(() => {
                this.textContent = originalText;
                this.style.backgroundColor = '';
                this.style.color = '';
              }, 1500);
            });
          });
        });

        // Attach Autofill Events
        const autofillBtns = savesList.querySelectorAll('.autofill-btn');
        autofillBtns.forEach((btn) => {
          btn.addEventListener('click', async function () {
            const u = this.getAttribute('data-username');
            const p = this.getAttribute('data-password');
            const originalText = this.textContent;

            this.textContent = 'Filling...';
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });

            if (tab) {
              chrome.tabs.sendMessage(
                tab.id,
                { action: 'autofill', username: u, password: p },
                function (response) {
                  if (
                    chrome.runtime.lastError ||
                    !response ||
                    !response.success
                  ) {
                    btn.textContent = 'Failed';
                    btn.style.backgroundColor = '#ef4444'; /* Red */
                  } else {
                    btn.textContent = 'Done!';
                  }
                  setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.backgroundColor = '';
                  }, 2000);
                },
              );
            }
          });
        });
      } else {
        savesList.innerHTML =
          '<p class="error empty-state">Session expired. Please log out and back in.</p>';
      }
    } catch (error) {
      savesList.innerHTML =
        '<p class="error empty-state">Could not connect to server.</p>';
    }
  }

  // 5. Search Logic
  searchInput.addEventListener('input', function () {
    const searchTerm = this.value.toLowerCase();
    const allCards = savesList.querySelectorAll('.save-card');
    allCards.forEach((card) => {
      const titleText = card
        .querySelector('.save-title')
        .textContent.toLowerCase();
      const userText = card.querySelector('strong').textContent.toLowerCase();
      if (titleText.includes(searchTerm) || userText.includes(searchTerm)) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  });
});
