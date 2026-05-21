// ══════════════════════════════════════════════════════════════════════
// trend.js v2  —  Canvas-тренд с раздельным масштабированием осей
//
// Управление:
//   Колёсико над графиком (правее осей Y)  → масштаб X (время)
//   Колёсико над осью Y тега               → масштаб этой оси Y
//   Drag по оси Y тега                     → смещение по Y
//   Двойной клик по оси Y                  → сброс в авто-масштаб
// ══════════════════════════════════════════════════════════════════════

const Trend = (() => {

  // ── Константы ────────────────────────────────────────────────────────

  const BUFFER_MS       = 5 * 60 * 1000;   // 5 мин буфер
  const DEFAULT_WIN_SEC = 60;
  const AXIS_W          = 48;               // ширина одной оси Y (px)
  const BOTTOM_H        = 22;               // высота оси X (px)
  const MIN_STRIP_H     = 100;
  const DEFAULT_STRIP_H = 220;

  const TAG_COLORS = [
    '#60a5fa','#4ade80','#fbbf24','#f87171',
    '#c084fc','#22d3ee','#fb923c','#f472b6',
    '#a3e635','#34d399','#e879f9','#38bdf8'
  ];

  // ── Хранилище ────────────────────────────────────────────────────────

  // tagId → [{ts, value}]
  const _buffer  = new Map();

  // tagId → {color, label, fullPath, dataType, isBool, hidden}
  const _tagMeta = new Map();

  // groupId → strip-объект
  const _strips  = new Map();

  let _visible   = false;
  let _container = null;

  // ── Инициализация ────────────────────────────────────────────────────

  function init() {
    _container = document.getElementById('trend-container');
    if (!_container) return;
    rebuild();
  }

  function rebuild() {
    if (!_container) return;
    const project = window._state?.project;
    const groups  = project?.groups || [];

    if (groups.length === 0) {
      _container.innerHTML = '<div class="trend-empty">Нет групп мониторинга.<br>Создайте группу и добавьте теги.</div>';
      return;
    }

    // Удаляем полосы для несуществующих групп
    for (const [id, strip] of _strips) {
      if (!groups.find(g => g.id === id)) {
        strip.raf && cancelAnimationFrame(strip.raf);
        _strips.delete(id);
      }
    }

    _container.innerHTML = '';
    for (const group of groups) {
      _container.appendChild(buildStripElement(group));
    }
  }

  // ── Построение полосы ────────────────────────────────────────────────

  function buildStripElement(group) {
    const project  = window._state?.project;
    const tags     = getGroupTags(group, project);
    const existing = _strips.get(group.id);
    const h        = existing?.height     || DEFAULT_STRIP_H;
    const winSec   = existing?.windowSec  || DEFAULT_WIN_SEC;

    resolveTagMeta(tags, group);

    // Корневой элемент
    const wrapper = document.createElement('div');
    wrapper.className = 'trend-strip';
    wrapper.dataset.groupId = group.id;

    // Шапка
    const header = document.createElement('div');
    header.className = 'trend-strip-header';
    header.innerHTML = `
      <div class="trend-strip-title">
        <span class="trend-group-name">${escH(group.name)}</span>
        <span class="trend-interval">${group.pollIntervalMs} мс</span>
      </div>
      <div class="trend-strip-controls">
        <span class="trend-ctrl" title="Уменьшить окно" data-action="zoom-in"  data-gid="${group.id}">⊕</span>
        <span class="trend-ctrl" title="Увеличить окно" data-action="zoom-out" data-gid="${group.id}">⊖</span>
        <span class="trend-win-label" id="trend-win-${group.id}">${fmtWin(winSec)}</span>
      </div>`;
    wrapper.appendChild(header);

    header.addEventListener('click', e => {
      const action = e.target.dataset.action;
      const gid    = e.target.dataset.gid;
      if (!action || !gid) return;
      const s = _strips.get(gid);
      if (!s) return;
      s.windowSec = clampWin(s.windowSec * (action === 'zoom-in' ? 0.67 : 1.5));
      updateWindowLabel(gid, s.windowSec);
    });

    // Canvas-обёртка
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'trend-canvas-wrap';
    canvasWrap.style.height = h + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'trend-canvas';
    canvasWrap.appendChild(canvas);

    // Resizer
    const resizer = document.createElement('div');
    resizer.className = 'trend-resizer';
    canvasWrap.appendChild(resizer);
    setupResizer(resizer, canvasWrap, group.id);

    wrapper.appendChild(canvasWrap);

    // Легенда
    const legend = document.createElement('div');
    legend.className = 'trend-legend';
    legend.id = `trend-legend-${group.id}`;
    wrapper.appendChild(legend);

    // Регистрируем полосу
    const strip = {
      canvas, ctx: null, legendEl: legend, canvasWrap,
      height: h, windowSec: winSec,
      group,
      yOverrides: existing?.yOverrides || new Map(), // tagId → {min,max} | null=авто
      raf: null
    };
    _strips.set(group.id, strip);

    renderLegend(group.id);
    setupCanvasInteraction(canvas, group.id);

    return wrapper;
  }

  // ── Метаданные тегов ─────────────────────────────────────────────────

  function resolveTagMeta(tags, group) {
    tags.forEach((tag, idx) => {
      if (_tagMeta.has(tag.id)) return;
      _tagMeta.set(tag.id, {
        color:    TAG_COLORS[idx % TAG_COLORS.length],
        label:    shortLabel(tag.displayName || tag.symbolicPath || tag.id),
        fullPath: tag.symbolicPath || tag.id,
        dataType: tag.dataType || '',
        isBool:   /^bool$/i.test(tag.dataType || ''),
        hidden:   false
      });
    });
  }

  function shortLabel(path) {
    return path.replace(/"/g, '').split('.').pop() || path;
  }

  // ── Легенда ──────────────────────────────────────────────────────────

  function renderLegend(groupId) {
    const strip   = _strips.get(groupId);
    const project = window._state?.project;
    if (!strip || !project) return;

    const group = project.groups.find(g => g.id === groupId);
    if (!group) return;
    const tags = getGroupTags(group, project);

    strip.legendEl.innerHTML = tags.map(tag => {
      const meta = _tagMeta.get(tag.id);
      if (!meta) return '';
      return `
        <div class="trend-legend-item ${meta.hidden ? 'hidden' : ''}"
             data-tag-id="${tag.id}" data-group-id="${groupId}"
             title="${escH(meta.fullPath)}">
          <span class="trend-legend-dot" style="background:${meta.color}"></span>
          <span class="trend-legend-label">${escH(meta.label)}</span>
          <span class="trend-legend-value" id="tlv-${tag.id}">—</span>
        </div>`;
    }).join('');

    strip.legendEl.addEventListener('click', e => {
      const item = e.target.closest('.trend-legend-item');
      if (!item) return;
      const meta = _tagMeta.get(item.dataset.tagId);
      if (!meta) return;
      meta.hidden = !meta.hidden;
      item.classList.toggle('hidden', meta.hidden);
    });
  }

  function updateLegendValue(tagId, value) {
    const el = document.getElementById(`tlv-${tagId}`);
    if (el) el.textContent = value ?? '—';
  }

  // ── Взаимодействие с Canvas ───────────────────────────────────────────

  function setupCanvasInteraction(canvas, groupId) {

    // Определяет: курсор над осью Y какого тега (или null = над графиком)
    function getTagAtX(clientX) {
      const rect  = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const curX   = (clientX - rect.left) * scaleX;
      const tags   = getVisibleTags(groupId);
      const leftMargin = tags.length * AXIS_W;
      if (curX >= leftMargin) return null;
      const idx = Math.floor(curX / AXIS_W);
      return idx < tags.length ? tags[idx] : null;
    }

    // ── Курсор мыши ──────────────────────────────────────────────────
    canvas.addEventListener('mousemove', e => {
      canvas.style.cursor = getTagAtX(e.clientX) ? 'ns-resize' : 'crosshair';
    });
    canvas.addEventListener('mouseleave', () => {
      canvas.style.cursor = 'crosshair';
    });

    // ── Колёсико ──────────────────────────────────────────────────────
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const tag = getTagAtX(e.clientX);

      if (tag) {
        // Масштаб оси Y этого тега
        const rect   = canvas.getBoundingClientRect();
        const scaleY = canvas.height / rect.height;
        const curY   = (e.clientY - rect.top) * scaleY;
        scaleYAxis(groupId, tag.id, curY, e.deltaY);
      } else {
        // Масштаб X (время)
        const s = _strips.get(groupId);
        if (!s) return;
        s.windowSec = clampWin(s.windowSec * (e.deltaY > 0 ? 1.5 : 0.67));
        updateWindowLabel(groupId, s.windowSec);
      }
    }, { passive: false });

    // ── Drag по оси Y — смещение ──────────────────────────────────────
    canvas.addEventListener('mousedown', e => {
      const tag = getTagAtX(e.clientX);
      if (!tag) return;

      const startY = e.clientY;
      const { min: r0min, max: r0max } = getCurrentYRange(groupId, tag.id);
      const range   = r0max - r0min;
      const strip   = _strips.get(groupId);
      const plotH   = strip.canvas.height - BOTTOM_H;
      const rect    = canvas.getBoundingClientRect();
      const scaleY  = canvas.height / rect.height;

      const onMove = ev => {
        const dy        = (ev.clientY - startY) * scaleY;
        const valueDelt = (dy / plotH) * range;   // вниз → значения растут
        strip.yOverrides.set(tag.id, {
          min: r0min + valueDelt,
          max: r0max + valueDelt
        });
        updateOverrideIndicator(groupId, tag.id, true);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    // ── Двойной клик по оси Y — сброс в авто ─────────────────────────
    canvas.addEventListener('dblclick', e => {
      const tag = getTagAtX(e.clientX);
      if (!tag) return;
      const strip = _strips.get(groupId);
      strip?.yOverrides.delete(tag.id);
      updateOverrideIndicator(groupId, tag.id, false);
    });
  }

  // ── Масштаб оси Y ────────────────────────────────────────────────────

  function scaleYAxis(groupId, tagId, cursorY, deltaY) {
    const strip  = _strips.get(groupId);
    if (!strip) return;

    const plotH  = strip.canvas.height - BOTTOM_H;
    const { min, max } = getCurrentYRange(groupId, tagId);

    // Значение под курсором (пивот масштабирования)
    const pivot  = max - (cursorY / plotH) * (max - min);
    const factor = deltaY > 0 ? 1.35 : 0.74;

    strip.yOverrides.set(tagId, {
      min: pivot - (pivot - min) * factor,
      max: pivot + (max - pivot) * factor
    });
    updateOverrideIndicator(groupId, tagId, true);
  }

  // Возвращает текущий Y-диапазон (override или авто)
  function getCurrentYRange(groupId, tagId) {
    const strip    = _strips.get(groupId);
    const override = strip?.yOverrides?.get(tagId);
    if (override) return override;
    return calcAutoRange(groupId, tagId);
  }

  // Вычисляет авто-диапазон из видимых данных
  function calcAutoRange(groupId, tagId) {
    const meta = _tagMeta.get(tagId);
    if (meta?.isBool) return { min: -0.15, max: 1.15 };

    const strip  = _strips.get(groupId);
    const winMs  = (strip?.windowSec || DEFAULT_WIN_SEC) * 1000;
    const now    = Date.now();
    const buf    = _buffer.get(tagId) || [];
    const visible = buf.filter(p => p.ts >= now - winMs && p.ts <= now);

    if (visible.length === 0) return { min: 0, max: 1 };

    let yMin = Infinity, yMax = -Infinity;
    for (const p of visible) {
      if (p.value < yMin) yMin = p.value;
      if (p.value > yMax) yMax = p.value;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.12;
    return { min: yMin - pad, max: yMax + pad };
  }

  // Мини-индикатор блокировки оси (🔒 / пусто) в легенде
  function updateOverrideIndicator(groupId, tagId, locked) {
    // Можно добавить визуальный маркер. Пока — изменяем opacity точки в легенде.
    const item = document.querySelector(
      `.trend-legend-item[data-tag-id="${tagId}"][data-group-id="${groupId}"] .trend-legend-dot`);
    if (item) {
      item.style.boxShadow = locked ? '0 0 0 2px rgba(255,255,255,0.25)' : '';
      item.title = locked ? 'Масштаб зафиксирован. Двойной клик на ось Y для сброса' : '';
    }
  }

  // ── Приём данных ─────────────────────────────────────────────────────

  function push(plcSourceId, values) {
    for (const v of values) {
      if (!v.isGood) continue;

      // Bool → 1/0, число → float
      let numVal;
      if (v.value === 'True')  numVal = 1;
      else if (v.value === 'False') numVal = 0;
      else {
        numVal = parseFloat(v.value);
        if (isNaN(numVal)) continue;
      }

      let buf = _buffer.get(v.tagId);
      if (!buf) { buf = []; _buffer.set(v.tagId, buf); }
      buf.push({ ts: v.timestampMs, value: numVal });

      // Обрезаем буфер
      const cutoff = v.timestampMs - BUFFER_MS;
      let lo = 0;
      while (lo < buf.length && buf[lo].ts < cutoff) lo++;
      if (lo > 0) buf.splice(0, lo);

      // Значение в легенде
      updateLegendValue(v.tagId, v.value);
    }
  }

  // ── Рендеринг ────────────────────────────────────────────────────────

  function startRendering() {
    for (const groupId of _strips.keys()) {
      scheduleRender(groupId);
    }
  }

  function stopRendering() {
    for (const strip of _strips.values()) {
      if (strip.raf) { cancelAnimationFrame(strip.raf); strip.raf = null; }
    }
  }

  function scheduleRender(groupId) {
    const strip = _strips.get(groupId);
    if (!strip) return;
    strip.raf = requestAnimationFrame(() => {
      renderStrip(groupId);
      if (_visible) scheduleRender(groupId);
    });
  }

  function renderStrip(groupId) {
    const strip   = _strips.get(groupId);
    const project = window._state?.project;
    if (!strip || !project) return;

    const canvas = strip.canvas;
    const wrap   = strip.canvasWrap;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight - 4;
    if (W <= 0 || H <= 0) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    const ctx  = canvas.getContext('2d');
    const group = project.groups.find(g => g.id === groupId);
    if (!group) return;

    const visibleTags = getVisibleTags(groupId);

    // Временное окно
    const winMs     = strip.windowSec * 1000;
    const viewEnd   = Date.now();
    const viewStart = viewEnd - winMs;

    // Отступы
    const leftMargin = visibleTags.length * AXIS_W;
    const plotX  = leftMargin;
    const plotW  = W - leftMargin - 4;
    const plotH  = H - BOTTOM_H;

    // ── Фон
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // ── Сетка
    drawGrid(ctx, plotX, 0, plotW, plotH, viewStart, viewEnd);

    // ── Линии тегов
    visibleTags.forEach((tag, idx) => {
      const meta = _tagMeta.get(tag.id);
      if (!meta) return;
      const buf = _buffer.get(tag.id) || [];

      // Точки в видимом диапазоне + немного слева для непрерывности
      const pts = buf.filter(p => p.ts >= viewStart - 2000 && p.ts <= viewEnd);
      if (pts.length < 1) {
        // Ось Y рисуем всегда
        const { min, max } = getCurrentYRange(groupId, tag.id);
        drawYAxis(ctx, idx * AXIS_W, 0, AXIS_W, plotH, min, max, meta.color,
                  strip.yOverrides.has(tag.id));
        return;
      }

      const { min: yMin, max: yMax } = getCurrentYRange(groupId, tag.id);

      // Ось Y
      drawYAxis(ctx, idx * AXIS_W, 0, AXIS_W, plotH, yMin, yMax, meta.color,
                strip.yOverrides.has(tag.id));

      // Маппинг
      const toX = ts  => plotX + ((ts  - viewStart) / winMs) * plotW;
      const toY = val => plotH - Math.max(0, Math.min(1, (val - yMin) / (yMax - yMin))) * plotH;

      // Рисуем с clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, 0, plotW, plotH);
      ctx.clip();

      ctx.strokeStyle = meta.color;
      ctx.lineWidth   = 1.5;
      ctx.lineJoin    = 'round';
      ctx.beginPath();

      let prevY = null;
      let first  = true;

      for (const p of pts) {
        const x = toX(p.ts);
        const y = toY(p.value);
        if (first) { ctx.moveTo(x, y); first = false; }
        else if (meta.isBool) {
          ctx.lineTo(x, prevY);  // горизонталь на старом уровне
          ctx.lineTo(x, y);      // вертикаль
        } else {
          ctx.lineTo(x, y);
        }
        prevY = y;
      }
      ctx.stroke();
      ctx.restore();
    });

    // ── Ось X
    drawXAxis(ctx, plotX, plotH, plotW, BOTTOM_H, viewStart, viewEnd, strip.windowSec);
  }

  // ── Рисование осей и сетки ────────────────────────────────────────────

  function drawGrid(ctx, x, y, w, h, viewStart, viewEnd) {
    // Горизонтальные
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    for (let i = 1; i < 5; i++) {
      const py = y + (i / 5) * h;
      ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x + w, py); ctx.stroke();
    }
    // Вертикальные
    const stepMs  = gridStep(viewEnd - viewStart);
    const firstTs = Math.ceil(viewStart / stepMs) * stepMs;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let ts = firstTs; ts <= viewEnd; ts += stepMs) {
      const px = x + ((ts - viewStart) / (viewEnd - viewStart)) * w;
      ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
    }
  }

  function drawYAxis(ctx, x, y, w, h, yMin, yMax, color, locked) {
    // Фон оси
    ctx.fillStyle = locked ? 'rgba(30,20,10,0.92)' : 'rgba(13,17,23,0.92)';
    ctx.fillRect(x, y, w - 1, h);

    // Вертикальная линия
    ctx.strokeStyle = color + (locked ? 'cc' : '60');
    ctx.lineWidth   = locked ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x + w - 1, y);
    ctx.lineTo(x + w - 1, y + h);
    ctx.stroke();

    // Метки и засечки
    ctx.fillStyle  = color;
    ctx.font       = '9px "Courier New", monospace';
    ctx.textAlign  = 'right';

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v  = yMin + (yMax - yMin) * (1 - i / ticks);
      const py = y + (i / ticks) * h;
      ctx.fillText(fmtVal(v), x + w - 4, py + 3);
      ctx.strokeStyle = color + '30';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x + w - 5, py);
      ctx.lineTo(x + w - 1, py);
      ctx.stroke();
    }

    // Иконка замка если override
    if (locked) {
      ctx.fillStyle = color + 'aa';
      ctx.font      = '8px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('🔒', x + 2, y + 11);
    }

    ctx.textAlign = 'left';
  }

  function drawXAxis(ctx, x, y, w, h, viewStart, viewEnd, winSec) {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(x, y, w, h);

    const stepMs  = gridStep(viewEnd - viewStart);
    const firstTs = Math.ceil(viewStart / stepMs) * stepMs;

    ctx.fillStyle  = 'rgba(255,255,255,0.35)';
    ctx.font       = '9px "Courier New", monospace';
    ctx.textAlign  = 'center';

    for (let ts = firstTs; ts <= viewEnd; ts += stepMs) {
      const px  = x + ((ts - viewStart) / (viewEnd - viewStart)) * w;
      const d   = new Date(ts);
      const lbl = winSec <= 120
        ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(lbl, px, y + 14);
    }
    ctx.textAlign = 'left';
  }

  // ── Вспомогательные ──────────────────────────────────────────────────

  function getGroupTags(group, project) {
    return (group.tagIds || [])
      .map(tid => project?.tags?.find(t => t.id === tid))
      .filter(Boolean);
  }

  // Видимые теги полосы (enabled + не hidden в легенде)
  function getVisibleTags(groupId) {
    const project = window._state?.project;
    const strip   = _strips.get(groupId);
    if (!project || !strip) return [];
    const group   = project.groups.find(g => g.id === groupId);
    if (!group) return [];
    return getGroupTags(group, project).filter(t => {
      if (t.isEnabled === false) return false;
      const m = _tagMeta.get(t.id);
      return m && !m.hidden;
    });
  }

  function gridStep(durationMs) {
    const steps = [200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
    for (const s of steps) { if (durationMs / s <= 8) return s; }
    return 60000;
  }

  function fmtVal(v) {
    const a = Math.abs(v);
    if (a === 0)   return '0';
    if (a >= 10000) return (v / 1000).toFixed(0) + 'k';
    if (a >= 1000)  return (v / 1000).toFixed(1) + 'k';
    if (a >= 100)   return Math.round(v).toString();
    if (a >= 10)    return v.toFixed(1);
    return v.toFixed(2);
  }

  function fmtWin(sec) {
    return sec >= 60 ? Math.round(sec / 60) + 'м' : sec + 'с';
  }

  function clampWin(sec) {
    return Math.max(5, Math.min(300, sec));
  }

  function updateWindowLabel(groupId, sec) {
    const el = document.getElementById(`trend-win-${groupId}`);
    if (el) el.textContent = fmtWin(sec);
  }

  function escH(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Resizer полосы ────────────────────────────────────────────────────

  function setupResizer(resizerEl, wrapEl, groupId) {
    let startY, startH;
    resizerEl.addEventListener('mousedown', e => {
      startY = e.clientY;
      startH = wrapEl.clientHeight;
      const onMove = ev => {
        const newH = Math.max(MIN_STRIP_H, startH + ev.clientY - startY);
        wrapEl.style.height = newH + 'px';
        const s = _strips.get(groupId);
        if (s) s.height = newH;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ── Публичный API ─────────────────────────────────────────────────────

  function show() {
    _visible = true;
    init();
    startRendering();
  }

  function hide() {
    _visible = false;
    stopRendering();
  }

  return { show, hide, push, rebuild };

})();