// ══════════════════════════════════════════════════════════════
// live-data.js — живые данные из ПЛК через SignalR
//
// Подключение: добавить в project.html перед </body>:
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/microsoft-signalr/8.0.7/signalr.min.js"></script>
//   <script src="/js/live-data.js"></script>
// ══════════════════════════════════════════════════════════════

const LiveData = (() => {

  // ── Состояние ─────────────────────────────────────────────────────────────

  // Последние значения: tagId → { value, isGood, timestampMs }
  const _values = {};

  // Статус источников: plcSourceId → status
  const _status = {};

  let _conn = null;
  let _reconnectTimer = null;

  // ── SignalR ───────────────────────────────────────────────────────────────

  function buildConnection() {
    return new signalR.HubConnectionBuilder()
      .withUrl('/ws/live')
      .withAutomaticReconnect([1000, 2000, 5000, 10000, 30000])
      .build();
  }

  async function start() {
    _conn = buildConnection();

    // ── Входящие события ───────────────────────────────────────────────────

    // Сервер прислал пачку значений тегов
    _conn.on('tagValues', (plcSourceId, values) => {
      for (const v of values) {
        _values[v.tagId] = v;
        updateCell(v.tagId, v.value, v.isGood);
      }
      if (typeof Trend !== 'undefined') Trend.push(plcSourceId, values);
    });

    // Сервер прислал статус ПЛК (connecting / connected / error / disconnected)
    _conn.on('plcStatus', (plcSourceId, status, message) => {
      _status[plcSourceId] = { status, message };
      updatePlcStatusBadge(plcSourceId, status, message);
    });

    // ── События подключения ────────────────────────────────────────────────

    _conn.onreconnecting(() => {
      console.log('[LiveData] SignalR: переподключение...');
      showSignalRBadge('connecting');
    });

    _conn.onreconnected(() => {
      console.log('[LiveData] SignalR: восстановлено');
      showSignalRBadge('connected');
    });

    _conn.onclose(() => {
      console.log('[LiveData] SignalR: соединение закрыто');
      showSignalRBadge('disconnected');
    });

    // ── Запуск ────────────────────────────────────────────────────────────

    try {
      await _conn.start();
      console.log('[LiveData] SignalR подключён к /ws/live');
      showSignalRBadge('connected');
    } catch (err) {
      console.error('[LiveData] SignalR ошибка запуска:', err);
      showSignalRBadge('disconnected');
      _reconnectTimer = setTimeout(start, 5000);
    }
  }

  // ── DOM-обновление значений ───────────────────────────────────────────────

  function updateCell(tagId, value, isGood) {
    // Ищем ячейку по data-value-cell="<tagId>"
    // (атрибут добавляется в showGroupView() в project.js)
    const cell = document.querySelector(`[data-value-cell="${tagId}"]`);
    if (!cell) return;

    if (isGood && value !== null && value !== undefined) {
      cell.textContent = value;
      cell.className   = 'tag-value val-good';
    } else {
      cell.textContent = '—';
      cell.className   = 'tag-value val-bad';
    }
  }

  // Обновляем все ячейки видимой группы (при переключении вкладки)
  function refreshVisibleGroup() {
    for (const [tagId, v] of Object.entries(_values)) {
      updateCell(tagId, v.value, v.isGood);
    }
  }

  // ── Статус ПЛК в карточке источника ──────────────────────────────────────

  function updatePlcStatusBadge(plcSourceId, status, message) {
    const badge = document.querySelector(`[data-plc-status="${plcSourceId}"]`);
    if (!badge) return;

    const icons = {
      connecting:   '🔄',
      connected:    '🟢',
      error:        '🔴',
      disconnected: '⚫'
    };
    badge.textContent = (icons[status] || '⚫') + ' ' + (status === 'connected' ? 'Online' : status);
    badge.title       = message || '';
  }

  // Небольшой индикатор в углу страницы что SignalR жив
  function showSignalRBadge(status) {
    let el = document.getElementById('signalr-status');
    if (!el) return;
    el.className   = 'signalr-status ' + status;
    el.title       = 'SignalR: ' + status;
  }

  // ── REST API — управление мониторингом ────────────────────────────────────

  async function startMonitoring(plcSourceId) {
    const r = await fetch('/api/monitor/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ plcSourceId })
    });
    return r.json();
  }

  async function stopMonitoring(plcSourceId) {
    const r = await fetch('/api/monitor/stop', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ plcSourceId })
    });
    return r.json();
  }

  async function startAll() {
    const r = await fetch('/api/monitor/start-all', { method: 'POST' });
    return r.json();
  }

  async function stopAll() {
    const r = await fetch('/api/monitor/stop-all', { method: 'POST' });
    return r.json();
  }

  async function getStatus() {
    const r = await fetch('/api/monitor/status');
    return r.json();
  }

  // ── Кнопка "▶ Запустить" в таблице группы ────────────────────────────────
  // В project.js в showGroupView() кнопка: onclick="LiveData.toggleGroup(groupId)"

  async function toggleGroup(groupId) {
    // Берём plcSourceId из первого тега группы
    const project = window._state?.project;
    if (!project) return;

    const group = project.groups?.find(g => g.id === groupId);
    if (!group || !group.tagIds?.length) {
      showToast('Нет тегов в группе', 'error');
      return;
    }

    const tag = project.tags?.find(t => group.tagIds.includes(t.id));
    if (!tag) return;

    const plcSourceId = tag.plcSourceId;
    const status      = await getStatus();
    const src         = status.sources?.find(s => s.id === plcSourceId);

    if (src?.isActive) {
      await stopMonitoring(plcSourceId);
      showToast('Мониторинг остановлен', 'info');
    } else {
      await startMonitoring(plcSourceId);
      showToast('Подключение к ПЛК...', 'info');
    }
  }

  // ── Инициализация ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    start();
  });

  // ── Публичный API ─────────────────────────────────────────────────────────

  return {
    startMonitoring,
    stopMonitoring,
    startAll,
    stopAll,
    getStatus,
    toggleGroup,
    refreshVisibleGroup,
    getValues: () => _values,
    getStatus: () => _status
  };

})();