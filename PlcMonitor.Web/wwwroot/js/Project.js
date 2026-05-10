const API = '';

// ══ СОСТОЯНИЕ ══════════════════════════════════════════════
const state = {
  project:      null,
  plcSources:   [],
  scanResults:  {},
  groups:       [],
  staging:      [],
  activeGroupId: null,
  groupColors:  ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899']
};

// ══ УТИЛИТЫ ════════════════════════════════════════════════
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

function showTab(id) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById('tabBtn-' + id.replace('tab-', '')).classList.add('active');
}

function closeDialog(id) {
  document.getElementById(id).classList.remove('open');
}

function toggleSection(id) {
  document.getElementById(id).classList.toggle('collapsed');
}

// ══ ИНИЦИАЛИЗАЦИЯ ═══════════════════════════════════════════
async function init() {
  const res  = await fetch(`${API}/api/project`);
  const data = await res.json();

  if (!data.loaded) {
    showToast('Проект не открыт', 'error');
    setTimeout(() => window.location.href = '/', 1500);
    return;
  }

  state.project    = data.project;
  state.plcSources = data.project.plcSources || [];
  state.groups     = data.project.groups || [];

  document.getElementById('project-title').textContent = data.project.name;
  document.title = `PLC Monitor — ${data.project.name}`;

  renderGroupsList();
  renderStagingList();

  // Сначала загружаем все кэши
  for (const plc of state.plcSources) {
    if (plc.tiaProjectPath) {
      try {
        const r = await fetch(`${API}/api/scan/cache?projectPath=${encodeURIComponent(plc.tiaProjectPath)}`);
        const d = await r.json();
        if (d.results?.length > 0) state.scanResults[plc.id] = d.results[0];
      } catch(e) {}
    }
  }

  // Потом строим дерево — уже с данными
  buildTree();
  renderPlcCards();
}

// ══ РЕСАЙЗЕР ══════════════════════════════════════════════
(function() {
  const panel   = document.getElementById('left-panel');
  const resizer = document.getElementById('resizer');
  let startX, startW;
  resizer.addEventListener('mousedown', e => {
    startX = e.clientX; startW = panel.offsetWidth;
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  function onMove(e) {
    panel.style.width = Math.min(480, Math.max(220, startW + e.clientX - startX)) + 'px';
  }
  function onUp() {
    resizer.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
})();

// ══ КЭШИ СКАНИРОВАНИЯ ═════════════════════════════════════
async function tryLoadScanCache(plc) {
  try {
    const res  = await fetch(`${API}/api/scan/cache?projectPath=${encodeURIComponent(plc.tiaProjectPath)}`);
    const data = await res.json();
    if (data.results?.length > 0) {
      state.scanResults[plc.id] = data.results[0];
      // Если имя не задано или совпадает с IP — берём из скана
      if (!plc.name || plc.name === plc.ipAddress) {
        plc.name = data.results[0].plcName;
        plc.nameIsAuto = false; // после первого скана фиксируем имя
      }
      VTree.refresh(state.plcSources, state.scanResults);
      renderPlcCards();
    }
  } catch(e) {}
}

// ══ ДЕРЕВО ТЕГОВ ══════════════════════════════════════════
function buildTree() {
  const viewport = document.getElementById('tag-tree');
  VTree.init(viewport, state.plcSources, state.scanResults,
    (plcId, tag) => addToStaging(plcId, tag));
  renderPlcCards();
}

function makeNode(depth, icon, label, _d, _p, hint, hasChildren) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-children-wrap';

  const row = document.createElement('div');
  row.className = 'tree-node';
  row.style.paddingLeft = (depth * 14 + 6) + 'px';

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron' + (hasChildren ? '' : ' leaf');
  chevron.textContent = hasChildren ? '▶' : '';

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  iconEl.textContent = icon;

  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = label;
  if (hint) {
    const h = document.createElement('span');
    h.className = 'type-hint';
    h.textContent = ' ' + hint;
    labelEl.appendChild(h);
  }

  row.appendChild(chevron);
  row.appendChild(iconEl);
  row.appendChild(labelEl);
  wrap.appendChild(row);

  if (hasChildren) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = 'none';
    wrap.appendChild(children);
    row.addEventListener('click', () => {
      const open = children.style.display !== 'none';
      children.style.display = open ? 'none' : 'block';
      chevron.classList.toggle('open', !open);
    });
  }

  return wrap;
}

function makeLeaf(depth, icon, label, type, onAdd) {
  const row = document.createElement('div');
  row.className = 'tree-node';
  row.style.paddingLeft = (depth * 14 + 6) + 'px';

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron leaf';

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-icon';
  iconEl.textContent = icon;

  const labelEl = document.createElement('span');
  labelEl.className = 'tree-label';
  labelEl.textContent = label;
  if (type) {
    const h = document.createElement('span');
    h.className = 'type-hint';
    h.textContent = ' ' + type;
    labelEl.appendChild(h);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'tree-add-btn';
  addBtn.textContent = '+';
  addBtn.onclick = e => { e.stopPropagation(); onAdd(); };

  row.appendChild(chevron);
  row.appendChild(iconEl);
  row.appendChild(labelEl);
  row.appendChild(addBtn);

  const wrap = document.createElement('div');
  wrap.appendChild(row);
  return wrap;
}

function renderMember(container, member, depth, plcId) {
  if (!container) return;
  if (member.children?.length > 0) {
    const node = makeNode(depth, '▦', member.name, null, null, member.dataType, true);
    container.appendChild(node);
    for (const child of member.children)
      renderMember(node.querySelector('.tree-children'), child, depth + 1, plcId);
  } else {
    container.appendChild(
      makeLeaf(depth, '●', member.name, member.dataType, () => addToStaging(plcId, member))
    );
  }
}

function filterTree(query) {
  VTree.search(query);
}

// ══ ТЕКУЩИЙ НАБОР (STAGING) ════════════════════════════════
function addToStaging(plcId, tag) {
  if (state.staging.find(t => t.plcId === plcId && t.symbolicPath === tag.symbolicPath)) {
    showToast('Тег уже в наборе'); return;
  }
  state.staging.push({ plcId, ...tag });
  renderStagingList();
  showToast(`Добавлен: ${tag.name}`, 'success');
}

function removeFromStaging(index) {
  state.staging.splice(index, 1);
  renderStagingList();
}

function clearStaging() {
  state.staging = [];
  renderStagingList();
}

function renderStagingList() {
  const list    = document.getElementById('staging-list');
  const actions = document.getElementById('staging-actions');
  document.getElementById('staging-badge').textContent = state.staging.length;

  if (state.staging.length === 0) {
    list.innerHTML = '<div class="staging-empty">Добавьте теги из дерева<br>нажав [+]</div>';
    actions.style.display = 'none';
    return;
  }
  actions.style.display = 'flex';
  list.innerHTML = state.staging.map((t, i) => `
    <div class="staging-tag">
      <span class="staging-tag-name" title="${escHtml(t.symbolicPath||t.name)}">${escHtml(t.name)}</span>
      <span class="staging-tag-type">${escHtml(t.dataType||'')}</span>
      <span class="staging-remove" onclick="removeFromStaging(${i})">✕</span>
    </div>`).join('');
}

// ══ ГРУППЫ ════════════════════════════════════════════════
function renderGroupsList() {
  const list  = document.getElementById('groups-list');
  document.getElementById('groups-badge').textContent = state.groups.length;

  if (state.groups.length === 0) {
    list.innerHTML = '<div class="staging-empty" style="font-size:11px">Нет групп</div>';
    return;
  }
  list.innerHTML = state.groups.map((g, i) => {
    const color  = state.groupColors[i % state.groupColors.length];
    const active = g.id === state.activeGroupId ? 'active' : '';
    return `
      <div class="group-item ${active}" onclick="selectGroup('${g.id}')">
        <div class="group-dot" style="background:${color}"></div>
        <span class="group-name">${escHtml(g.name)}</span>
        <span class="group-interval">${g.pollIntervalMs}мс</span>
      </div>`;
  }).join('');
}

function selectGroup(id) {
  state.activeGroupId = id;
  renderGroupsList();
  showGroupView(id);
  showTab('tab-group');
}

function showGroupView(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const idx   = state.groups.indexOf(group);
  const color = state.groupColors[idx % state.groupColors.length];
  const tags  = (group.tagIds||[]).map(tid => state.project?.tags?.find(t => t.id === tid)).filter(Boolean);

  document.getElementById('group-view-container').innerHTML = `
    <div class="group-view">
      <div class="group-header">
        <div class="group-title-row">
          <div class="group-dot" style="width:12px;height:12px;background:${color};border-radius:50%;"></div>
          <div class="group-title">${escHtml(group.name)}</div>
          <div class="group-interval-badge">${group.pollIntervalMs} мс</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-ghost btn-sm" onclick="addStagingToGroup('${group.id}')">+ Добавить из набора</button>
          <button class="btn btn-ghost btn-sm">▶ Запустить</button>
        </div>
      </div>
      ${tags.length === 0 ? `
        <div class="empty-right" style="flex:0;padding:40px 0;">
          <div class="empty-right-icon">📋</div>
          <div>Группа пуста</div>
          <div style="font-size:11px;margin-top:4px;color:var(--text3)">Добавьте теги через «Текущий набор»</div>
        </div>` : `
        <table class="tags-table">
          <thead><tr><th></th><th>Имя</th><th>Путь</th><th>Тип</th><th>Значение</th><th></th></tr></thead>
          <tbody>${tags.map(t => `
            <tr>
              <td><div class="toggle-switch ${t.isEnabled?'on':''}" onclick="toggleTag('${t.id}',this)"></div></td>
              <td class="tag-name">${escHtml(t.displayName||t.symbolicPath)}</td>
              <td class="tag-path">${escHtml(t.symbolicPath||'')}</td>
              <td class="tag-type">${escHtml(t.dataType||'')}</td>
              <td class="tag-value no-data">—</td>
              <td><button class="btn btn-ghost btn-sm" onclick="removeTagFromGroup('${group.id}','${t.id}')">✕</button></td>
            </tr>`).join('')}
          </tbody>
        </table>`}
    </div>`;
}

async function addStagingToGroup(groupId) {
  if (state.staging.length === 0) { showToast('Текущий набор пуст', 'error'); return; }
  const plc = state.plcSources[0];
  if (!plc) { showToast('Нет ПЛК в проекте', 'error'); return; }

  for (const tag of state.staging) {
    await fetch(`${API}/api/project/tag`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        plcSourceId: tag.plcId || plc.id,
        symbolicPath: tag.symbolicPath, dataType: tag.dataType,
        displayName: tag.name, dbNumber: tag.dbNumber,
        byteOffset: tag.byteOffset, absoluteAddress: tag.absoluteAddress,
        groupId
      })
    });
  }

  const d = await (await fetch(`${API}/api/project`)).json();
  state.project = d.project;
  state.groups  = d.project.groups || [];
  const count = state.staging.length;
  clearStaging();
  renderGroupsList();
  showGroupView(groupId);
  showToast(`Добавлено ${count} тегов в группу`, 'success');
}

async function removeTagFromGroup(groupId, tagId) {
  await fetch(`${API}/api/project/group/${groupId}/tag/${tagId}`, { method: 'DELETE' });
  const d = await (await fetch(`${API}/api/project`)).json();
  state.project = d.project;
  state.groups  = d.project.groups || [];
  renderGroupsList();
  showGroupView(groupId);
}

async function toggleTag(tagId, el) {
  const isOn = el.classList.toggle('on');
  await fetch(`${API}/api/project/tag/${tagId}/${isOn?'enable':'disable'}`, { method: 'PATCH' });
}

async function deletePlc(plcId, name) {
  if (!confirm(`Удалить ПЛК "${name}"?`)) return;

  await fetch(`${API}/api/project/plc/${plcId}`, { method: 'DELETE' });

  state.plcSources = state.plcSources.filter(p => p.id !== plcId);
  delete state.scanResults[plcId];

  renderPlcCards();
  buildTree();
  showToast(`ПЛК "${name}" удалён`, '');
}

// ══ ПЛК КАРТОЧКИ ══════════════════════════════════════════
function renderPlcCards() {
  const container = document.getElementById('plc-cards');
  if (state.plcSources.length === 0) {
    container.innerHTML = `
      <div class="empty-right" style="flex:0;padding:30px 0 20px;">
        <div class="empty-right-icon">🔌</div><div>Нет ПЛК</div>
      </div>`;
    return;
  }
  container.innerHTML = state.plcSources.map(plc => {
    const hasScan = !!state.scanResults[plc.id];
    return `
      <div class="plc-card">
        <div class="plc-card-header">
          <div style="display:flex;align-items:center;gap:8px;flex:1;">
            <input 
              id="plc-name-${plc.id}"
              value="${escHtml(plc.name||plc.ipAddress)}"
              style="background:transparent;border:none;border-bottom:1px solid transparent;
                    font-family:var(--sans);font-size:14px;font-weight:600;color:#fff;
                    outline:none;flex:1;min-width:0;padding:2px 4px;border-radius:4px;
                    cursor:pointer;"
              onmouseover="this.style.borderBottomColor='var(--border2)'"
              onmouseout="if(document.activeElement!==this)this.style.borderBottomColor='transparent'"
              onfocus="this.style.borderBottomColor='var(--accent)';this.style.background='var(--bg3)'"
              onblur="this.style.borderBottomColor='transparent';this.style.background='transparent';
                      updatePlcName('${plc.id}',this.value)"
              onkeydown="if(event.key==='Enter')this.blur()">
          </div>
          <div class="plc-card-status">
            <div class="status-dot ${hasScan?'online':''}"></div>
            <span>${hasScan?'Просканирован':'Не просканирован'}</span>
          </div>
        </div>        <div class="plc-fields">
          <div class="field"><label>IP адрес</label><input value="${escHtml(plc.ipAddress||'')}" readonly></div>
          <div class="field"><label>Rack / Slot</label><input value="${plc.rack} / ${plc.slot}" readonly></div>
          <div class="field full">
            <label>TIA проект</label>
            <div style="display:flex;gap:6px;">
              <input id="tia-path-${plc.id}" value="${escHtml(plc.tiaProjectPath||'')}"
                    style="flex:1;font-size:11px" 
                    onchange="updateTiaPath('${plc.id}', this.value)">
              <button class="btn btn-ghost btn-sm" onclick="browseTiaProjectForPlc('${plc.id}')"
                      style="flex-shrink:0;">📁</button>
            </div>
          </div>        <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
          <button class="btn btn-primary btn-sm" onclick="startScan('${plc.id}')">🔍 Сканировать проект</button>
          <button class="btn btn-ghost btn-sm" onclick="deletePlc('${plc.id}','${escHtml(plc.name||'')}')">🗑 Удалить</button>
          ${hasScan ? `<span style="font-size:11px;color:var(--green);">✓ ${countTags(plc.id)} тегов</span>` : ''}
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--text3);">
          ⚠ TIA Portal должен быть открыт перед сканированием
        </div>
        <div class="scan-progress" id="scan-progress-${plc.id}">
          <span id="scan-msg-${plc.id}">Инициализация...</span>
          <div class="scan-log" id="scan-log-${plc.id}"></div>
        </div>
      </div>`;
  }).join('');
}

async function updatePlcName(plcId, newName) {
  const plc = state.plcSources.find(p => p.id === plcId);
  if (!plc || plc.name === newName.trim()) return;
  plc.name = newName.trim() || plc.ipAddress;
  plc.nameIsAuto = false; // пользователь задал имя вручную — не перезаписываем
  // Сохраняем проект
  await fetch(`${API}/api/project/save`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  });
  VTree.refresh(state.plcSources, state.scanResults);
}

let _browsingFile = false;

async function browseTiaProject() {
  if (_browsingFile) return;
  _browsingFile = true;
  try {
    const res  = await fetch('/api/config/browse-tia', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.cancelled && data.path) {
      document.getElementById('plc-tia-path').value = data.path;
      document.getElementById('tia-path-status').textContent = '✓ Файл выбран';
      document.getElementById('tia-path-status').style.color = 'var(--green)';
      validateAddPlcForm();

      // Пробуем прочитать имена ПЛК из проекта
      try {
        const nr = await fetch(`/api/config/plc-names?projectPath=${encodeURIComponent(data.path)}`);
        const nd = await nr.json();
        if (nd.plcs?.length > 0) {
          // Подставляем первый ПЛК если поле пустое
          const nameField = document.getElementById('plc-name');
          if (!nameField.value.trim())
            nameField.value = nd.plcs[0].name;

          // Если несколько ПЛК — показываем список для выбора
          if (nd.plcs.length > 1) {
            showPlcNameSuggestions(nd.plcs);
          }
        }
      } catch(e) { /* TIA Portal не открыт — ничего, поле просто останется пустым */ }
    }
  } catch(e) {
    showToast('Выбор файла отменён', '');
  } finally {
    _browsingFile = false;
  }
}

function showPlcNameSuggestions(plcs) {
  const status = document.getElementById('tia-path-status');
  const btns   = plcs.map(p =>
    `<button class="btn btn-ghost btn-sm" style="margin:2px"
       onclick="document.getElementById('plc-name').value='${escHtml(p.name)}';
                this.parentNode.innerHTML='✓ Файл выбран';
                validateAddPlcForm();">
       ${escHtml(p.name)}
     </button>`
  ).join('');
  status.innerHTML = `Найдено ПЛК — выберите: ${btns}`;
  status.style.color = 'var(--text2)';
}

async function updateTiaPath(plcId, newPath) {
  // Обновляем локально
  const plc = state.plcSources.find(p => p.id === plcId);
  if (plc) plc.tiaProjectPath = newPath;
  // Сохраняем проект
  await fetch(`${API}/api/project/save`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  });
  showToast('Путь обновлён', 'success');
}

function countTags(plcId) {
  const scan = state.scanResults[plcId];
  if (!scan) return 0;
  let n = 0;
  (scan.tagTables||[]).forEach(t => n += t.tags?.length||0);
  (scan.dataBlocks||[]).forEach(d => n += countMembers(d.members||[]));
  return n;
}

function countMembers(members) {
  let n = 0;
  for (const m of members) {
    if (m.children?.length > 0) n += countMembers(m.children);
    else n++;
  }
  return n;
}

async function startScan(plcId) {
  const plc     = state.plcSources.find(p => p.id === plcId);
  const tiaPath = plc?.tiaProjectPath;
  if (!tiaPath) { showToast('Путь к TIA проекту не указан', 'error'); return; }

  // Проверяем кэш
  try {
    const cacheRes = await fetch(`/api/scan/cache?projectPath=${encodeURIComponent(tiaPath)}`);
    const cache    = await cacheRes.json();
    if (cache.isValid && cache.results?.length > 0) {
      state.scanResults[plcId] = cache.results[0];
      buildTree();
      showToast('Загружен кэш сканирования ✓', 'success');
      return;
    }
    if (cache.isStale && cache.results?.length > 0) {
      const useCache = confirm(
        `Кэш устарел.\nПроект изменён: ${new Date(cache.projectModified).toLocaleString('ru-RU')}\n\nИспользовать кэш? (Отмена = пересканировать)`
      );
      if (useCache) {
        state.scanResults[plcId] = cache.results[0];
        buildTree();
        showToast('Загружен кэш сканирования', '');
        return;
      }
    }
  } catch(e) {}

  // Показываем прогресс ДО запуска — даём браузеру отрисовать
  renderPlcCards();
  await new Promise(r => setTimeout(r, 100));

  const progress = document.getElementById(`scan-progress-${plcId}`);
  const msgEl    = document.getElementById(`scan-msg-${plcId}`);
  const logEl    = document.getElementById(`scan-log-${plcId}`);
  if (progress) progress.classList.add('active');
  if (msgEl)    msgEl.textContent = 'Запускаем сканер...';

  // Запускаем — НЕ ждём завершения fetch, только статус 200/ошибку
  let startOk = false;
  try {
    const res = await fetch('/api/scan/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ projectPath: tiaPath })
    });
    startOk = res.ok;
    if (!res.ok) {
      const err = await res.text();
      if (msgEl) msgEl.textContent = 'Ошибка: ' + err;
      showToast('Ошибка запуска: ' + err, 'error');
      return;
    }
  } catch(e) {
    if (msgEl) msgEl.textContent = 'Ошибка связи с сервером';
    showToast('Ошибка: ' + e.message, 'error');
    return;
  }

  // Поллинг статуса
  let polling = false;
  const interval = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const status = await (await fetch('/api/scan/status')).json();

      if (msgEl) msgEl.textContent = status.lastMessage || '...';
      if (logEl && status.log?.length > 0) {
        logEl.innerHTML = status.log.slice(-10).map(l =>
          `<div class="scan-log-line ${l.includes('ОШИБКА')?'err':''}">${escHtml(l)}</div>`
        ).join('');
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (!status.isRunning && status.isComplete) {
        clearInterval(interval);
        await tryLoadScanCache({ id: plcId, tiaProjectPath: tiaPath });
        buildTree();
        showToast('Сканирование завершено ✓', 'success');
      }

      if (status.error) {
        clearInterval(interval);
        // Оставляем прогресс видимым с ошибкой
        if (msgEl) msgEl.textContent = '❌ ' + status.error;
        showToast('Ошибка: ' + status.error, 'error');
      }
    } finally {
      polling = false;
    }
  }, 1000);
}

// ══ ДИАЛОГ — Добавить ПЛК ═════════════════════════════════
function openAddPlcDialog() {
  document.getElementById('plc-name').value     = '';
  document.getElementById('plc-ip').value       = '192.168.0.1';
  document.getElementById('plc-rack').value     = '0';
  document.getElementById('plc-slot').value     = '1';
  document.getElementById('plc-tia-path').value = '';
  document.getElementById('tia-path-status').textContent = 'Выберите файл проекта TIA Portal';
  document.getElementById('tia-path-status').style.color = 'var(--text3)';

  const btn = document.getElementById('btn-add-plc');
  btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed';

  // Слушаем изменения полей
  ['plc-ip','plc-tia-path'].forEach(id => {
    document.getElementById(id).oninput = validateAddPlcForm;
  });

  document.getElementById('dlg-add-plc').classList.add('open');
  setTimeout(() => document.getElementById('plc-name').focus(), 100);
}

let _pathCheckTimer = null;
let _pathChecking   = false;
function validateAddPlcForm() {
  const ok = document.getElementById('plc-ip').value.trim().length > 0
          && document.getElementById('plc-tia-path').value.trim().length > 0;
  const btn = document.getElementById('btn-add-plc');
  btn.disabled      = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
  btn.style.cursor  = ok ? 'pointer' : 'not-allowed';
}

function setAddBtn(enabled, btn) {
  btn = btn || document.getElementById('btn-add-plc');
  btn.disabled       = !enabled;
  btn.style.opacity  = enabled ? '1' : '0.5';
  btn.style.cursor   = enabled ? 'pointer' : 'not-allowed';
}

async function addPlc() {
  const ip         = document.getElementById('plc-ip').value.trim();
  const tia        = document.getElementById('plc-tia-path').value.trim();
  const tiaFileName = tia.split('\\').pop().replace(/\.ap\d+$/i, '');
  const customName = document.getElementById('plc-name').value.trim();
  const name       = customName || tiaFileName || ip;
  const nameIsAuto = !customName;
  const rack = parseInt(document.getElementById('plc-rack').value) || 0;
  const slot = parseInt(document.getElementById('plc-slot').value) || 1;

  if (!ip || !tia) { showToast('Заполните обязательные поля', 'error'); return; }

  // Быстрая проверка файла
  try {
    const check = await fetch(`/api/config/check-path?path=${encodeURIComponent(tia)}`);
    const data  = await check.json();
    if (!data.exists) {
      document.getElementById('tia-path-status').textContent = '✗ Файл не найден';
      document.getElementById('tia-path-status').style.color = 'var(--red)';
      showToast('Файл проекта TIA не найден', 'error');
      return;
    }
  } catch(e) {}

  const res = await fetch(`${API}/api/project/plc`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, ipAddress: ip, rack, slot, tiaProjectPath: tia, nameIsAuto })
  });

  const plc = await res.json();
  state.plcSources.push(plc);
  closeDialog('dlg-add-plc');
  renderPlcCards();
  addPlcNodeToTree(plc);
  showToast(`ПЛК "${name}" добавлен`, 'success');
}

function addPlcNodeToTree(plc) {
  // Обновляем виртуальное дерево
  VTree.refresh(state.plcSources, state.scanResults);
}

async function browseTiaProject() {
  try {
    const res  = await fetch('/api/config/browse-tia', { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.cancelled && data.path) {
      document.getElementById('plc-tia-path').value = data.path;
      validateAddPlcForm();
    }
  } catch(e) { showToast('Выбор файла отменён', ''); }
}

// ══ ДИАЛОГ — Группы ═══════════════════════════════════════
function openNewGroupDialog() {
  document.getElementById('dlg-new-group').classList.add('open');
  setTimeout(() => document.getElementById('grp-name').focus(), 100);
}

async function createGroup() {
  const name = document.getElementById('grp-name').value.trim();
  const ms   = parseInt(document.getElementById('grp-interval').value);
  if (!name) { showToast('Введите название', 'error'); return; }

  const res   = await fetch(`${API}/api/project/group`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, pollIntervalMs: ms })
  });
  const group = await res.json();
  state.groups.push(group);
  closeDialog('dlg-new-group');
  renderGroupsList();
  selectGroup(group.id);
  showToast(`Группа "${name}" создана`, 'success');
}

function openSaveGroupDialog() {
  document.getElementById('dlg-save-group').classList.add('open');
  setTimeout(() => document.getElementById('save-grp-name').focus(), 100);
}

async function saveGroupFromStaging() {
  const name = document.getElementById('save-grp-name').value.trim();
  const ms   = parseInt(document.getElementById('save-grp-interval').value);
  if (!name) { showToast('Введите название', 'error'); return; }
  if (state.staging.length === 0) { showToast('Набор пуст', 'error'); return; }

  const res   = await fetch(`${API}/api/project/group`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, pollIntervalMs: ms })
  });
  const group = await res.json();
  state.groups.push(group);
  closeDialog('dlg-save-group');
  await addStagingToGroup(group.id);
  selectGroup(group.id);
}

// ══ СОХРАНИТЬ ПРОЕКТ ════════════════════════════════════════
async function saveProject() {
  const res = await fetch(`${API}/api/project/save`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  });
  if (res.ok) showToast('Проект сохранён', 'success');
  else showToast('Ошибка сохранения', 'error');
}

// ══ ИНИЦИАЛИЗАЦИЯ СОБЫТИЙ ═══════════════════════════════════
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});
document.getElementById('grp-name').addEventListener('keydown', e => { if (e.key==='Enter') createGroup(); });
document.getElementById('save-grp-name').addEventListener('keydown', e => { if (e.key==='Enter') saveGroupFromStaging(); });

// ══ СТАРТ ═══════════════════════════════════════════════════
init();