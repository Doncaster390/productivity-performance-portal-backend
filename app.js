(function(){
  var DEFAULT_API = 'http://localhost:5000';
  var apiBase = localStorage.getItem('pppApiBase') || DEFAULT_API;
  var adminToken = localStorage.getItem('pppAdminToken') || null;

  var el = {
    banner: document.getElementById('banner'),
    entryCount: document.getElementById('entryCount'),
    staffToggleBtn: document.getElementById('staffToggleBtn'),
    staffPanel: document.getElementById('staffPanel'),
    loginCard: document.getElementById('loginCard'),
    loginForm: document.getElementById('loginForm'),
    pinInput: document.getElementById('pinInput'),
    loginBtn: document.getElementById('loginBtn'),
    adminCard: document.getElementById('adminCard'),
    queueList: document.getElementById('queueList'),
    queueEmpty: document.getElementById('queueEmpty'),
    logoutBtn: document.getElementById('logoutBtn'),
    submitForm: document.getElementById('submitForm'),
    titleInput: document.getElementById('titleInput'),
    urlInput: document.getElementById('urlInput'),
    submitBtn: document.getElementById('submitBtn'),
    registryGrid: document.getElementById('registryGrid'),
    registryEmpty: document.getElementById('registryEmpty'),
    apiBaseLabel: document.getElementById('apiBaseLabel'),
    settingsToggleBtn: document.getElementById('settingsToggleBtn'),
    settingsRow: document.getElementById('settingsRow'),
    apiBaseInput: document.getElementById('apiBaseInput'),
    saveApiBaseBtn: document.getElementById('saveApiBaseBtn')
  };

  function showBanner(message, kind){
    el.banner.innerHTML = '<div class="banner ' + (kind || 'error') + '">' + escapeHtml(message) + '</div>';
    if (kind !== 'error') {
      setTimeout(function(){ el.banner.innerHTML = ''; }, 4000);
    }
  }
  function clearBanner(){ el.banner.innerHTML = ''; }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function classify(url){
    var u = (url || '').toLowerCase();
    if (u.indexOf('powerpoint') > -1 || u.endsWith('.pptx') || u.endsWith('.ppt')) {
      return { label: 'Deck', cls: 'type-deck' };
    }
    if (u.indexOf('powerbi') > -1) {
      return { label: 'Dashboard', cls: 'type-dashboard' };
    }
    if (u.indexOf('excel') > -1 || u.endsWith('.xlsx') || u.endsWith('.xls')) {
      return { label: 'Workbook', cls: 'type-workbook' };
    }
    return { label: 'Link', cls: 'type-link' };
  }

  function formatDate(d){
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
    } catch(e){ return ''; }
  }

  function regNo(id){
    return 'No. ' + String(id).padStart(4, '0');
  }

  async function apiFetch(path, opts){
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.json) {
      headers['Content-Type'] = 'application/json';
    }
    var res = await fetch(apiBase.replace(/\/$/, '') + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.json ? JSON.stringify(opts.json) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch(e){}
    if (!res.ok) {
      var msg = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function renderRegistry(links){
    el.registryGrid.innerHTML = '';
    el.entryCount.textContent = links.length + (links.length === 1 ? ' entry on file' : ' entries on file');
    if (!links.length) {
      el.registryEmpty.style.display = 'block';
      return;
    }
    el.registryEmpty.style.display = 'none';
    links.forEach(function(link){
      var type = classify(link.url);
      var li = document.createElement('li');
      li.className = 'reg-card';
      li.innerHTML =
        '<div class="reg-no">' + regNo(link.id) + '</div>' +
        '<div class="reg-title">' + escapeHtml(link.title) + '</div>' +
        '<span class="type-pill ' + type.cls + '">' + type.label + '</span><br>' +
        '<a class="reg-url" href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(link.url) + '</a>' +
        '<div class="reg-filed">Filed ' + formatDate(link.created_at) + '</div>' +
        '<div class="stamp approved">Approved</div>';
      el.registryGrid.appendChild(li);
    });
  }

  function renderQueue(links){
    var pending = links.filter(function(l){ return !l.approved; });
    el.queueList.innerHTML = '';
    if (!pending.length) {
      el.queueEmpty.style.display = 'block';
      return;
    }
    el.queueEmpty.style.display = 'none';
    pending.forEach(function(link){
      var type = classify(link.url);
      var li = document.createElement('li');
      li.className = 'queue-item';
      li.innerHTML =
        '<div class="meta">' +
          '<div class="title-line">' + escapeHtml(link.title) + ' <span class="type-pill ' + type.cls + '">' + type.label + '</span></div>' +
          '<a class="url-line" href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(link.url) + '</a>' +
        '</div>' +
        '<div class="queue-actions">' +
          '<button class="btn btn-approve" data-approve="' + link.id + '">Approve</button>' +
          '<button class="btn btn-delete" data-delete="' + link.id + '">Delete</button>' +
        '</div>';
      el.queueList.appendChild(li);
    });

    el.queueList.querySelectorAll('[data-approve]').forEach(function(btn){
      btn.addEventListener('click', function(){ approveLink(btn.getAttribute('data-approve')); });
    });
    el.queueList.querySelectorAll('[data-delete]').forEach(function(btn){
      btn.addEventListener('click', function(){ deleteLink(btn.getAttribute('data-delete')); });
    });
  }

  async function loadPublicRegistry(){
    try {
      var links = await apiFetch('/api/links');
      renderRegistry(links);
    } catch (err) {
      showBanner('Could not reach the registry. Check the API address below and try again.');
    }
  }

  async function loadAdminQueue(){
    try {
      var links = await apiFetch('/api/admin/links', {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      renderQueue(links);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        logout();
        showBanner('Session expired. Log in again.');
      } else {
        showBanner('Could not load the review queue.');
      }
    }
  }

  async function approveLink(id){
    try {
      await apiFetch('/api/admin/links/' + id + '/approve', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      showBanner('Entry approved and published.', 'info');
      loadAdminQueue();
      loadPublicRegistry();
    } catch (err) {
      showBanner('Could not approve that entry.');
    }
  }

  async function deleteLink(id){
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    try {
      await apiFetch('/api/admin/links/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      showBanner('Entry deleted.', 'info');
      loadAdminQueue();
      loadPublicRegistry();
    } catch (err) {
      showBanner('Could not delete that entry.');
    }
  }

  function logout(){
    adminToken = null;
    localStorage.removeItem('pppAdminToken');
    el.adminCard.style.display = 'none';
    el.loginCard.style.display = 'block';
  }

  function setSignedIn(){
    el.loginCard.style.display = 'none';
    el.adminCard.style.display = 'block';
    el.staffToggleBtn.classList.add('is-active');
    el.staffToggleBtn.textContent = 'Staff panel';
    loadAdminQueue();
  }

  el.staffToggleBtn.addEventListener('click', function(){
    var open = el.staffPanel.classList.toggle('open');
    if (open && adminToken) {
      setSignedIn();
    }
  });

  el.loginForm.addEventListener('submit', async function(e){
    e.preventDefault();
    clearBanner();
    el.loginBtn.disabled = true;
    el.loginBtn.textContent = 'Logging in…';
    try {
      var data = await apiFetch('/api/admin/login', {
        method: 'POST',
        json: { password: el.pinInput.value }
      });
      adminToken = data.token;
      localStorage.setItem('pppAdminToken', adminToken);
      el.pinInput.value = '';
      setSignedIn();
    } catch (err) {
      showBanner('Incorrect PIN.');
    } finally {
      el.loginBtn.disabled = false;
      el.loginBtn.textContent = 'Log in';
    }
  });

  el.logoutBtn.addEventListener('click', logout);

  el.submitForm.addEventListener('submit', async function(e){
    e.preventDefault();
    clearBanner();
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = 'Filing…';
    try {
      await apiFetch('/api/links', {
        method: 'POST',
        json: { title: el.titleInput.value, url: el.urlInput.value }
      });
      el.titleInput.value = '';
      el.urlInput.value = '';
      showBanner('Filed for review. It will appear once a staff member approves it.', 'info');
      if (adminToken) loadAdminQueue();
    } catch (err) {
      showBanner('Could not file that entry. Check the title and link, then try again.');
    } finally {
      el.submitBtn.disabled = false;
      el.submitBtn.textContent = 'Submit for review';
    }
  });

  el.settingsToggleBtn.addEventListener('click', function(){
    el.settingsRow.classList.toggle('open');
    el.apiBaseInput.value = apiBase;
  });
  el.saveApiBaseBtn.addEventListener('click', function(){
    var val = el.apiBaseInput.value.trim();
    if (!val) return;
    apiBase = val;
    localStorage.setItem('pppApiBase', apiBase);
    el.apiBaseLabel.textContent = apiBase;
    el.settingsRow.classList.remove('open');
    showBanner('API address updated.', 'info');
    loadPublicRegistry();
    if (adminToken) loadAdminQueue();
  });

  el.apiBaseLabel.textContent = apiBase;
  if (adminToken) {
    el.staffPanel.classList.add('open');
    setSignedIn();
  }
  loadPublicRegistry();
})();
