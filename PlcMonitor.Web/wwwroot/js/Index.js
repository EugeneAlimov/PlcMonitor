const API = '';

// ── Утилиты ────────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 8000);
}

// ── Последние проекты ──────────────────────────────────────
function getRecentProjects() {
  try { return JSON.parse(localStorage.getItem('plcmon_recent') || '[]'); }
  catch { return []; }
}

function addRecentProject(name, filePath) {
  const list = getRecentProjects().filter(p => p.filePath !== filePath);
  list.unshift({ name, filePath, opened: new Date().toISOString() });
  localStorage.setItem('plcmon_recent', JSON.stringify(list.slice(0, 10)));
  renderRecentProjects();
}

function renderRecentProjects() {
  const list = getRecentProjects();
  const el   = document.getElementById('recent-projects');

  if (list.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📂</div>
        <div>Нет последних проектов</div>
        <div style="margin-top:4px;font-size:11px">Создайте новый или откройте существующий</div>
      </div>`;
    return;
  }

  el.innerHTML = list.map(p => {
    const date = new Date(p.opened).toLocaleString('ru-RU', {
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
    });
    return `
      <div class="project-card" data-path="${escHtml(p.filePath)}" data-name="${escHtml(p.name)}" onclick="openRecentProject(this)">
        <div class="project-card-left">
          <div class="project-icon">📊</div>
          <div class="project-info">
            <div class="project-name">${escHtml(p.name)}</div>
            <div class="project-meta">${escHtml(p.filePath)}</div>
          </div>
        </div>
        <div class="project-card-right">
          <span class="badge">${date}</span>
          <span class="project-arrow">›</span>
        </div>
      </div>`;
  }).join('');
}

// ── Диалог — Новый проект ──────────────────────────────────
async function openNewProjectDialog() {
  document.getElementById('new-project-name').value = '';
  document.getElementById('path-preview').textContent = '...';

  let defaultDir = 'C:\\Users\\User\\Documents\\PlcMonitor\\';
  try {
    const r = await fetch('/api/config/defaults');
    if (r.ok) { const d = await r.json(); defaultDir = d.defaultSaveDir + '\\'; }
  } catch {}

  document.getElementById('new-project-path').value = defaultDir;
  document.getElementById('new-project-overlay').classList.add('open');
  setTimeout(() => document.getElementById('new-project-name').focus(), 100);
}

function closeNewProjectDialog() {
  document.getElementById('new-project-overlay').classList.remove('open');
}

async function browseSaveFolder() {
  const current = document.getElementById('new-project-path').value;
  try {
    const res = await fetch(
      `/api/config/browse-folder?initial=${encodeURIComponent(current)}`,
      { signal: AbortSignal.timeout(60000) }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.cancelled && data.path) {
      document.getElementById('new-project-path').value = data.path + '\\';
      updatePathPreview();
    }
  } catch(e) { showToast('Выбор папки отменён', ''); }
}

function updatePathPreview() {
  const name = document.getElementById('new-project-name').value.trim();
  const dir  = document.getElementById('new-project-path').value.trim().replace(/\\$/, '');
  document.getElementById('path-preview').textContent = name ? `${dir}\\${name}.plcmon` : '...';
}

async function createNewProject() {
  const name      = document.getElementById('new-project-name').value.trim();
  const pathInput = document.getElementById('new-project-path').value.trim();
  if (!name) { showToast('Введите название проекта', 'error'); return; }

  let filePath = pathInput.endsWith('.plcmon')
    ? pathInput
    : pathInput.replace(/\\$/, '') + '\\' + name + '.plcmon';

  try {
    const r1 = await fetch(`${API}/api/project/new`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name })
    });
    if (!r1.ok) throw new Error(await r1.text());

    const r2 = await fetch(`${API}/api/project/save`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filePath })
    });
    if (!r2.ok) throw new Error(await r2.text());

    addRecentProject(name, filePath);
    closeNewProjectDialog();
    showToast(`Проект "${name}" создан`, 'success');
    setTimeout(() => { window.location.href = '/project.html'; }, 800);
  } catch(e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

// ── Диалог — Открыть проект ────────────────────────────────
function openProjectFile() {
  document.getElementById('open-project-path').value = '';
  document.getElementById('open-project-overlay').classList.add('open');
  setTimeout(() => document.getElementById('open-project-path').focus(), 100);
}

function closeOpenProjectDialog() {
  document.getElementById('open-project-overlay').classList.remove('open');
}

async function browseOpenFile() {
  try {
    const res = await fetch('/api/config/browse-file', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.cancelled && data.path)
      document.getElementById('open-project-path').value = data.path;
  } catch(e) { showToast('Выбор файла отменён', ''); }
}

async function confirmOpenProject() {
  const filePath = document.getElementById('open-project-path').value.trim();
  if (!filePath) { showToast('Укажите путь к файлу', 'error'); return; }
  const name = filePath.split('\\').pop().replace('.plcmon', '');
  closeOpenProjectDialog();
  await loadProject(filePath, name);
}

function openRecentProject(el) {
  loadProject(el.dataset.path, el.dataset.name);
}

async function loadProject(filePath, name) {
  try {
    const res = await fetch(`${API}/api/project/load`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filePath })
    });
    if (!res.ok) throw new Error(await res.text());
    addRecentProject(name, filePath);
    showToast(`Проект "${name}" открыт`, 'success');
    setTimeout(() => { window.location.href = '/project.html'; }, 800);
  } catch(e) {
    showToast('Ошибка открытия: ' + e.message, 'error');
  }
}

// ── Инициализация ──────────────────────────────────────────
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});
document.getElementById('new-project-name').addEventListener('keydown', e => { if (e.key==='Enter') createNewProject(); });
document.getElementById('new-project-name').addEventListener('input', updatePathPreview);
document.getElementById('open-project-path').addEventListener('keydown', e => { if (e.key==='Enter') confirmOpenProject(); });

renderRecentProjects();