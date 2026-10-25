// ══════════════════════════════════════════════════════════════════════
// trend.js v4
//
// Зоны взаимодействия:
//   Над осью Y тега  → колёсико: масштаб этой оси Y
//                      drag: смещение по Y
//                      двойной клик: сброс в авто
//   Над осью X (низ) → колёсико: масштаб X
//   Над графиком     → колёсико: масштаб X
//
// Активная ось Y (под курсором) выделяется жирной линией и крупным шрифтом.
// WORD/BYTE/DWORD/LWORD отображаются в легенде как 16#XXXX.
//
// Какие группы показывать — панель-переключатель над полосами и ✕ в шапке.
// По умолчанию новая группа на тренд не выводится. Выбор хранится в
// localStorage отдельно для каждого проекта.
//
// Курсоры (кнопка ⌖ в шапке полосы):
//   Две вертикальные линии. Позиция хранится как доля окна (0..1),
//   т.е. в живом режиме линии стоят на месте экрана, а данные текут
//   под ними. Drag за линию — перемещение.
//   Таблица под графиком: значения тегов на C1/C2, ∆Y, ∆T.
//   Значение на курсоре = последний отсчёт ≤ времени курсора
//   (sample & hold — честно для опрашиваемых данных, без интерполяции).
// ══════════════════════════════════════════════════════════════════════

const Trend = (() => {

  // ── Константы ────────────────────────────────────────────────────────

  const BUFFER_MS       = 5 * 60 * 1000;
  const DEFAULT_WIN_SEC = 60;
  const AXIS_W          = 52;
  const BOTTOM_H        = 26;
  const FONT_NORM       = '11px "Courier New", monospace';
  const FONT_ACTIVE     = '12px "Courier New", monospace';
  const MIN_STRIP_H     = 100;
  const CURSOR_HIT_PX   = 6;                 // зона захвата линии курсора
  const CURSOR_COLORS   = ['#e6edf3', '#fbbf24'];
  const TABLE_UPDATE_MS = 200;               // частота обновления таблицы курсоров
  const DEFAULT_STRIP_H = 220;

  const TAG_COLORS = [
    '#60a5fa','#4ade80','#fbbf24','#f87171',
    '#c084fc','#22d3ee','#fb923c','#f472b6',
    '#a3e635','#34d399','#e879f9','#38bdf8'
  ];

  const HEX_DT    = new Set(['BYTE','WORD','DWORD','LWORD']);
  const HEX_WIDTH = { BYTE:2, WORD:4, DWORD:8, LWORD:16 };

  // ── Хранилище ────────────────────────────────────────────────────────

  const _buffer  = new Map();  // tagId → [{ts, value}]
  const _tagMeta = new Map();  // tagId → метаданные
  const _strips  = new Map();  // groupId → strip

  let _visible   = false;
  let _container = null;
  let _shown     = null;         // Set<groupId> — какие группы на тренде

  // ── Выбор групп ──────────────────────────────────────────────────────

  function storageKey() {
    return 'plcmon.trend.shown.' + (window._state?.project?.name || '');
  }

  function loadShown() {
    try { _shown = new Set(JSON.parse(localStorage.getItem(storageKey()) || '[]')); }
    catch { _shown = new Set(); }
  }

  function saveShown() {
    try { localStorage.setItem(storageKey(), JSON.stringify([..._shown])); } catch {}
  }

  function setShown(gid, on) {
    if (on) _shown.add(gid); else _shown.delete(gid);
    saveShown();
    rebuild();
  }

  // ── Инициализация ────────────────────────────────────────────────────

  function init() {
    _container = document.getElementById('trend-container');
    if (!_container) return;
    rebuild();
  }

  function rebuild() {
    if (!_container) return;
    stopRendering();
    if (!_shown) loadShown();

    const groups = window._state?.project?.groups || [];
    if (!groups.length) {
      _strips.clear();
      _container.innerHTML = '<div class="trend-empty">Нет групп. Создайте группу и добавьте теги.</div>';
      return;
    }

    // Чистим выбор от удалённых групп
    for (const id of [..._shown])
      if (!groups.find(g => g.id === id)) _shown.delete(id);

    // Полосы скрытых/удалённых групп выбрасываем
    for (const id of [..._strips.keys()])
      if (!_shown.has(id)) _strips.delete(id);

    _container.innerHTML = '';
    _container.appendChild(buildPicker(groups));

    const shownGroups = groups.filter(g => _shown.has(g.id));
    if (!shownGroups.length) {
      const e = document.createElement('div');
      e.className = 'trend-empty';
      e.textContent = 'Выберите группы для отображения на панели выше';
      _container.appendChild(e);
    }
    shownGroups.forEach(g => _container.appendChild(buildStrip(g)));

    if (_visible) startRendering();
  }

  function buildPicker(groups) {
    const bar = document.createElement('div');
    bar.className = 'trend-picker';
    bar.innerHTML = '<span class="trend-picker-label">На тренде:</span>' +
      groups.map(g => `
        <span class="trend-chip ${_shown.has(g.id) ? 'on' : ''}" data-gid="${g.id}"
              title="${_shown.has(g.id) ? 'Убрать с тренда' : 'Показать на тренде'}">
          ${escH(g.name)} <span class="trend-chip-count">${(g.tagIds || []).length}</span>
        </span>`).join('');
    bar.addEventListener('click', e => {
      const chip = e.target.closest('.trend-chip');
      if (chip) setShown(chip.dataset.gid, !_shown.has(chip.dataset.gid));
    });
    return bar;
  }

  // ── Построение полосы ─────────────────────────────────────────────────

  function buildStrip(group) {
    const project  = window._state?.project;
    const existing = _strips.get(group.id);
    const h        = existing?.height    || DEFAULT_STRIP_H;
    const winSec   = existing?.windowSec || DEFAULT_WIN_SEC;

    resolveTagMeta(getGroupTags(group, project), group);

    const wrap = document.createElement('div');
    wrap.className = 'trend-strip';
    wrap.dataset.groupId = group.id;

    // Шапка
    const hdr = document.createElement('div');
    hdr.className = 'trend-strip-header';
    hdr.innerHTML = `
      <div class="trend-strip-title">
        <span class="trend-group-name">${escH(group.name)}</span>
        <span class="trend-interval">${group.pollIntervalMs} мс</span>
      </div>
      <div class="trend-strip-controls">
        <span class="trend-ctrl" data-action="cursors"  data-gid="${group.id}" id="trend-cur-btn-${group.id}" title="Курсоры">⌖</span>
        <span class="trend-ctrl" data-action="zoom-in"  data-gid="${group.id}" title="Уменьшить окно">⊕</span>
        <span class="trend-ctrl" data-action="zoom-out" data-gid="${group.id}" title="Увеличить окно">⊖</span>
        <span class="trend-win-label" id="trend-win-${group.id}">${fmtWin(winSec)}</span>
        <span class="trend-ctrl trend-close" data-action="close" data-gid="${group.id}" title="Убрать с тренда">✕</span>
      </div>`;
    hdr.addEventListener('click', e => {
      const act = e.target.dataset.action;
      const gid = e.target.dataset.gid;
      if (!act || !gid) return;
      const s = _strips.get(gid);
      if (!s) return;
      if (act === 'cursors') { toggleCursors(gid); return; }
      if (act === 'close')   { setShown(gid, false); return; }
      s.windowSec = clampWin(s.windowSec * (act === 'zoom-in' ? 0.67 : 1.5));
      updateWinLabel(gid, s.windowSec);
    });
    wrap.appendChild(hdr);

    // Canvas-обёртка
    const cWrap = document.createElement('div');
    cWrap.className = 'trend-canvas-wrap';
    cWrap.style.height = h + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'trend-canvas';
    cWrap.appendChild(canvas);

    const rsz = document.createElement('div');
    rsz.className = 'trend-resizer';
    cWrap.appendChild(rsz);
    setupResizer(rsz, cWrap, group.id);
    wrap.appendChild(cWrap);

    // Таблица курсоров
    const curTbl = document.createElement('div');
    curTbl.className = 'trend-cursor-table';
    curTbl.style.display = existing?.cursors ? '' : 'none';
    wrap.appendChild(curTbl);

    // Легенда
    const leg = document.createElement('div');
    leg.className = 'trend-legend';
    leg.id = `trend-legend-${group.id}`;
    wrap.appendChild(leg);

    // Strip-объект
    const strip = {
      canvas, cWrap, legendEl: leg,
      height: h, windowSec: winSec,
      group,
      yOverrides:   existing?.yOverrides || new Map(),
      hoveredTagId: null,
      cursors:      existing?.cursors || null,   // null | [f1, f2], доля окна 0..1
      cursorTableEl: curTbl,
      lastTableUpd: 0,
      view:         null,                      // геометрия последнего кадра
      raf: null
    };
    _strips.set(group.id, strip);
    if (strip.cursors) setTimeout(() => setCursorBtn(group.id, true));

    renderLegend(group.id);
    setupInteraction(canvas, group.id);
    return wrap;
  }

  // ── Метаданные тегов ─────────────────────────────────────────────────

  function resolveTagMeta(tags, group) {
    tags.forEach((tag, i) => {
      if (_tagMeta.has(tag.id)) return;
      const dt = (tag.dataType || '').toUpperCase();
      _tagMeta.set(tag.id, {
        color:    TAG_COLORS[i % TAG_COLORS.length],
        label:    shortLabel(tag.displayName || tag.symbolicPath || tag.id),
        fullPath: tag.symbolicPath || tag.id,
        dataType: dt,
        isBool:   dt === 'BOOL',
        isHex:    HEX_DT.has(dt),
        hidden:   false
      });
    });
  }

  function shortLabel(p) { return p.replace(/"/g,'').split('.').pop() || p; }

  // ── Легенда ──────────────────────────────────────────────────────────

  function renderLegend(gid) {
    const strip = _strips.get(gid);
    const proj  = window._state?.project;
    if (!strip || !proj) return;
    const group = proj.groups.find(g => g.id === gid);
    if (!group) return;
    const tags  = getGroupTags(group, proj);

    strip.legendEl.innerHTML = tags.map(t => {
      const m = _tagMeta.get(t.id);
      if (!m) return '';
      return `<div class="trend-legend-item ${m.hidden?'hidden':''}"
                   data-tag-id="${t.id}" data-group-id="${gid}"
                   title="${escH(m.fullPath)}">
                <span class="trend-legend-dot" id="tld-${t.id}" style="background:${m.color}"></span>
                <span class="trend-legend-label">${escH(m.label)}</span>
                <span class="trend-legend-value" id="tlv-${t.id}">—</span>
              </div>`;
    }).join('');

    strip.legendEl.addEventListener('click', e => {
      const item = e.target.closest('.trend-legend-item');
      if (!item) return;
      const m = _tagMeta.get(item.dataset.tagId);
      if (!m) return;
      m.hidden = !m.hidden;
      item.classList.toggle('hidden', m.hidden);
    });
  }

  function updateLegendValue(tagId, raw) {
    const el = document.getElementById(`tlv-${tagId}`);
    if (!el) return;
    const m  = _tagMeta.get(tagId);
    el.textContent = fmtLegendVal(raw, m?.dataType);
  }

  function fmtLegendVal(raw, dt) {
    if (raw == null) return '—';
    const DT = (dt || '').toUpperCase();
    if (HEX_DT.has(DT)) {
      const n = parseInt(raw);
      if (!isNaN(n)) return '16#' + n.toString(16).toUpperCase().padStart(HEX_WIDTH[DT] || 4, '0');
    }
    return String(raw);
  }

  // ── Зоны взаимодействия ───────────────────────────────────────────────

  // Возвращает { zone: 'yaxis'|'xaxis'|'plot', tag, curX, curY } в px canvas
  function getZone(canvas, gid, clientX, clientY) {
    const rect  = canvas.getBoundingClientRect();
    const sx    = canvas.width  / rect.width;
    const sy    = canvas.height / rect.height;
    const cx    = (clientX - rect.left) * sx;
    const cy    = (clientY - rect.top)  * sy;
    const tags  = getVisibleTags(gid);
    const lm    = tags.length * AXIS_W;
    const pH    = canvas.height - BOTTOM_H;

    if (cx < lm) {
      const idx = Math.floor(cx / AXIS_W);
      return { zone: 'yaxis', tag: idx < tags.length ? tags[idx] : null, curX: cx, curY: cy };
    }
    if (cy > pH) return { zone: 'xaxis', tag: null, curX: cx, curY: cy };

    const ci = cursorAt(gid, cx);
    if (ci !== -1) return { zone: 'cursor', tag: null, cursor: ci, curX: cx, curY: cy };
    return { zone: 'plot', tag: null, curX: cx, curY: cy };
  }

  // ── Взаимодействие ───────────────────────────────────────────────────

  function setupInteraction(canvas, gid) {
    const z = e => getZone(canvas, gid, e.clientX, e.clientY);

    canvas.addEventListener('mousemove', e => {
      const info = z(e);
      const s    = _strips.get(gid);
      if (s) s.hoveredTagId = info.zone === 'yaxis' && info.tag ? info.tag.id : null;
      canvas.style.cursor =
        info.zone === 'yaxis'  ? 'ns-resize' :
        info.zone === 'cursor' ? 'col-resize' :
        info.zone === 'xaxis'  ? 'ew-resize' : 'crosshair';
    });

    canvas.addEventListener('mouseleave', () => {
      const s = _strips.get(gid);
      if (s) s.hoveredTagId = null;
      canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const info = z(e);
      const s    = _strips.get(gid);
      if (!s) return;
      if (info.zone === 'yaxis' && info.tag) {
        scaleY(gid, info.tag.id, info.curY, e.deltaY);
      } else {
        // xaxis или plot — оба масштабируют X
        s.windowSec = clampWin(s.windowSec * (e.deltaY > 0 ? 1.5 : 0.67));
        updateWinLabel(gid, s.windowSec);
      }
    }, { passive: false });

    // Drag курсора
    canvas.addEventListener('mousedown', e => {
      const info = z(e);
      if (info.zone !== 'cursor') return;
      const s  = _strips.get(gid);
      const ci = info.cursor;
      const rect = canvas.getBoundingClientRect();
      const sX   = canvas.width / rect.width;

      const onMove = ev => {
        const v = s.view;
        if (!v || !s.cursors) return;
        let x = (ev.clientX - rect.left) * sX;
        x = Math.max(v.pX, Math.min(v.pX + v.pW, x));
        s.cursors[ci] = (x - v.pX) / v.pW;
        s.lastTableUpd = 0;                    // таблицу — сразу
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    // Drag по оси Y
    canvas.addEventListener('mousedown', e => {
      const info = z(e);
      if (info.zone !== 'yaxis' || !info.tag) return;
      const tagId  = info.tag.id;
      const startY = e.clientY;
      const { min: r0, max: r1 } = getCurRange(gid, tagId);
      const range  = r1 - r0;
      const s      = _strips.get(gid);
      const rect   = canvas.getBoundingClientRect();
      const sY     = canvas.height / rect.height;
      const pH     = canvas.height - BOTTOM_H;

      const onMove = ev => {
        const d = (ev.clientY - startY) * sY;
        const v = (d / pH) * range;
        s.yOverrides.set(tagId, { min: r0 + v, max: r1 + v });
        setLock(tagId, true);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    // Двойной клик — сброс Y
    canvas.addEventListener('dblclick', e => {
      const info = z(e);
      if (info.zone !== 'yaxis' || !info.tag) return;
      _strips.get(gid)?.yOverrides.delete(info.tag.id);
      setLock(info.tag.id, false);
    });
  }

  // ── Масштаб Y ────────────────────────────────────────────────────────

  function scaleY(gid, tagId, curY, delta) {
    const s = _strips.get(gid);
    if (!s) return;
    const pH = s.canvas.height - BOTTOM_H;
    const { min, max } = getCurRange(gid, tagId);
    const pivot  = max - (curY / pH) * (max - min);
    const f      = delta > 0 ? 1.35 : 0.74;
    s.yOverrides.set(tagId, { min: pivot - (pivot - min)*f, max: pivot + (max - pivot)*f });
    setLock(tagId, true);
  }

  function getCurRange(gid, tagId) {
    return _strips.get(gid)?.yOverrides?.get(tagId) || calcAutoRange(gid, tagId);
  }

  function calcAutoRange(gid, tagId) {
    const m = _tagMeta.get(tagId);
    if (m?.isBool) return { min: -0.15, max: 1.15 };
    const s   = _strips.get(gid);
    const now = Date.now();
    const buf = (_buffer.get(tagId) || []).filter(p => p.ts >= now - (s?.windowSec||60)*1000);
    if (!buf.length) return { min: 0, max: 1 };
    let lo = Infinity, hi = -Infinity;
    for (const p of buf) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12;
    return { min: lo - pad, max: hi + pad };
  }

  function setLock(tagId, on) {
    const dot = document.getElementById(`tld-${tagId}`);
    if (dot) {
      dot.style.boxShadow = on ? '0 0 0 2px rgba(255,255,255,0.3)' : '';
      dot.title = on ? 'Зафиксировано. Двойной клик на ось Y для сброса' : '';
    }
  }

  // ── Приём данных ─────────────────────────────────────────────────────

  function push(plcSourceId, values) {
    for (const v of values) {
      if (!v.isGood) continue;
      let num;
      if      (v.value === 'True')  num = 1;
      else if (v.value === 'False') num = 0;
      else { num = parseFloat(v.value); if (isNaN(num)) continue; }

      let buf = _buffer.get(v.tagId);
      if (!buf) { buf = []; _buffer.set(v.tagId, buf); }
      buf.push({ ts: v.timestampMs, value: num });
      const cut = v.timestampMs - BUFFER_MS;
      let lo = 0;
      while (lo < buf.length && buf[lo].ts < cut) lo++;
      if (lo) buf.splice(0, lo);

      updateLegendValue(v.tagId, v.value);
    }
  }

  // ── Рендеринг ────────────────────────────────────────────────────────

  function startRendering() {
    for (const id of _strips.keys()) schedule(id);
  }

  function stopRendering() {
    for (const s of _strips.values()) { if (s.raf) { cancelAnimationFrame(s.raf); s.raf = null; } }
  }

  function schedule(gid) {
    const s = _strips.get(gid);
    if (!s) return;
    s.raf = requestAnimationFrame(() => { renderStrip(gid); if (_visible) schedule(gid); });
  }

  function renderStrip(gid) {
    const s    = _strips.get(gid);
    const proj = window._state?.project;
    if (!s || !proj) return;

    const cv = s.canvas;
    const W  = s.cWrap.clientWidth;
    const H  = s.cWrap.clientHeight - 4;
    if (W <= 0 || H <= 0) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

    const ctx   = cv.getContext('2d');
    const group = proj.groups.find(g => g.id === gid);
    if (!group) return;

    const tags  = getVisibleTags(gid);
    const winMs = s.windowSec * 1000;
    const now   = Date.now();
    const vEnd  = now;
    const vStart = now - winMs;
    const lm    = tags.length * AXIS_W;
    const pX    = lm;
    const pW    = W - lm - 4;
    const pH    = H - BOTTOM_H;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    drawGrid(ctx, pX, 0, pW, pH, vStart, vEnd);

    tags.forEach((tag, idx) => {
      const m      = _tagMeta.get(tag.id);
      if (!m) return;
      const buf    = _buffer.get(tag.id) || [];
      const pts    = buf.filter(p => p.ts >= vStart - 2000 && p.ts <= vEnd);
      const active = s.hoveredTagId === tag.id;
      const locked = s.yOverrides.has(tag.id);
      const { min: yMin, max: yMax } = getCurRange(gid, tag.id);

      drawYAxis(ctx, idx * AXIS_W, 0, AXIS_W, pH, yMin, yMax, m.color, locked, active);

      if (!pts.length) return;

      const toX = ts  => pX + ((ts - vStart) / winMs) * pW;
      const toY = val => pH - Math.max(0, Math.min(1, (val - yMin)/(yMax - yMin))) * pH;

      ctx.save();
      ctx.beginPath(); ctx.rect(pX, 0, pW, pH); ctx.clip();
      ctx.strokeStyle = m.color;
      ctx.lineWidth   = active ? 2.5 : 1.5;
      ctx.lineJoin    = 'round';
      ctx.beginPath();

      let pY = null, first = true;
      for (const p of pts) {
        const x = toX(p.ts), y = toY(p.value);
        if (first) { ctx.moveTo(x, y); first = false; }
        else if (m.isBool) { ctx.lineTo(x, pY); ctx.lineTo(x, y); }
        else ctx.lineTo(x, y);
        pY = y;
      }
      ctx.stroke();
      ctx.restore();
    });

    drawXAxis(ctx, pX, pH, pW, BOTTOM_H, vStart, vEnd, s.windowSec);

    s.view = { vStart, winMs, pX, pW, pH };
    if (s.cursors) {
      drawCursors(ctx, gid, tags);
      if (now - s.lastTableUpd >= TABLE_UPDATE_MS) {
        s.lastTableUpd = now;
        renderCursorTable(gid, tags);
      }
    }
  }

  // ── Курсоры ──────────────────────────────────────────────────────────

  function toggleCursors(gid) {
    const s = _strips.get(gid);
    if (!s) return;
    if (s.cursors) {
      s.cursors = null;
    } else {
      s.cursors = [1/3, 2/3];
    }
    s.lastTableUpd = 0;
    s.cursorTableEl.style.display = s.cursors ? '' : 'none';
    if (!s.cursors) s.cursorTableEl.innerHTML = '';
    setCursorBtn(gid, !!s.cursors);
  }

  function setCursorBtn(gid, on) {
    document.getElementById(`trend-cur-btn-${gid}`)?.classList.toggle('active', on);
  }

  // Индекс курсора под X (px canvas) или -1
  function cursorAt(gid, cx) {
    const s = _strips.get(gid);
    const v = s?.view;
    if (!s?.cursors || !v) return -1;
    let best = -1, bestD = CURSOR_HIT_PX + 1;
    s.cursors.forEach((f, i) => {
      const d = Math.abs(v.pX + f * v.pW - cx);
      if (d < bestD) { bestD = d; best = i; }
    });
    return bestD <= CURSOR_HIT_PX ? best : -1;
  }

  // Последний отсчёт с ts ≤ t (бинарный поиск), либо null
  function valueAt(tagId, t) {
    const buf = _buffer.get(tagId);
    if (!buf || !buf.length || buf[0].ts > t) return null;
    let lo = 0, hi = buf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buf[mid].ts <= t) lo = mid; else hi = mid - 1;
    }
    return buf[lo].value;
  }

  function drawCursors(ctx, gid, tags) {
    const s = _strips.get(gid);
    const { vStart, winMs, pX, pW, pH } = s.view;

    s.cursors.forEach((f, ci) => {
      const ts = vStart + f * winMs;
      const x  = pX + f * pW;
      const col = CURSOR_COLORS[ci];

      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1;
      ctx.setLineDash(ci === 0 ? [] : [5, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, pH); ctx.stroke();
      ctx.setLineDash([]);

      // Маркеры пересечения с линиями тегов
      tags.forEach(tag => {
        const val = valueAt(tag.id, ts);
        if (val == null) return;
        const { min, max } = getCurRange(gid, tag.id);
        const y = pH - Math.max(0, Math.min(1, (val - min) / (max - min))) * pH;
        ctx.fillStyle   = _tagMeta.get(tag.id)?.color || col;
        ctx.strokeStyle = '#0d1117';
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });

      // Ярлык "C1"/"C2" сверху и время на оси X
      ctx.font = FONT_NORM;
      const lbl = 'C' + (ci + 1);
      const lw  = ctx.measureText(lbl).width + 8;
      const lx  = Math.min(x + 2, pX + pW - lw);
      ctx.fillStyle = col;
      ctx.fillRect(lx, 0, lw, 15);
      ctx.fillStyle = '#0d1117';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, lx + 4, 11);

      const tl  = fmtTimeMs(ts);
      const tw  = ctx.measureText(tl).width + 8;
      const tx  = Math.max(pX, Math.min(x - tw / 2, pX + pW - tw));
      ctx.fillStyle = col;
      ctx.fillRect(tx, pH + 2, tw, BOTTOM_H - 4);
      ctx.fillStyle = '#0d1117';
      ctx.fillText(tl, tx + 4, pH + 17);
      ctx.restore();
    });
  }

  function renderCursorTable(gid, tags) {
    const s = _strips.get(gid);
    const v   = s.view;
    if (!v) return;
    const [t1, t2] = s.cursors.map(f => v.vStart + f * v.winMs);
    const dT  = t2 - t1;

    const rows = tags.map(tag => {
      const m  = _tagMeta.get(tag.id);
      const a  = valueAt(tag.id, t1);
      const b  = valueAt(tag.id, t2);
      const d  = (a != null && b != null) ? b - a : null;
      return `<tr>
        <td><span class="trend-legend-dot" style="background:${m.color}"></span>${escH(m.label)}</td>
        <td>${fmtCurVal(a, m)}</td>
        <td>${fmtCurVal(b, m)}</td>
        <td>${d == null ? '—' : fmtDelta(d, m)}</td>
      </tr>`;
    }).join('');

    s.cursorTableEl.innerHTML = `
      <table>
        <thead><tr>
          <th></th>
          <th style="color:${CURSOR_COLORS[0]}">C1 ${fmtTimeMs(t1)}</th>
          <th style="color:${CURSOR_COLORS[1]}">C2 ${fmtTimeMs(t2)}</th>
          <th>∆ = ${fmtDur(dT)}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function fmtCurVal(v, m) {
    if (v == null) return '—';
    if (m.isBool)  return v ? 'TRUE' : 'FALSE';
    if (m.isHex)   return fmtLegendVal(v, m.dataType);
    return fmtNum(v);
  }

  function fmtDelta(d, m) {
    if (m.isBool) return d === 0 ? '=' : (d > 0 ? '↑' : '↓');
    const sign = d > 0 ? '+' : '';
    return sign + fmtNum(d);                       // hex-типы — дельта десятичная
  }

  function fmtNum(v) {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(1) : a >= 1 ? v.toFixed(3) : v.toPrecision(4);
  }

  function fmtTimeMs(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
         + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function fmtDur(ms) {
    const sign = ms < 0 ? '−' : '';
    ms = Math.abs(ms);
    if (ms < 1000)  return sign + Math.round(ms) + ' мс';
    if (ms < 60000) return sign + (ms / 1000).toFixed(3) + ' с';
    const m = Math.floor(ms / 60000);
    return sign + m + ' мин ' + ((ms % 60000) / 1000).toFixed(1) + ' с';
  }

  // ── Рисование ────────────────────────────────────────────────────────

  function drawGrid(ctx, x, y, w, h, vS, vE) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    for (let i = 1; i < 5; i++) {
      const py = y + i/5 * h;
      ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x+w, py); ctx.stroke();
    }
    const step = gridStep(vE - vS);
    const first = Math.ceil(vS / step) * step;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let ts = first; ts <= vE; ts += step) {
      const px = x + (ts - vS)/(vE - vS) * w;
      ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y+h); ctx.stroke();
    }
  }

  function drawYAxis(ctx, x, y, w, h, yMin, yMax, color, locked, active) {
    ctx.fillStyle = locked ? 'rgba(28,22,10,0.95)'
                  : active ? 'rgba(25,30,40,0.97)'
                           : 'rgba(13,17,23,0.93)';
    ctx.fillRect(x, y, w-1, h);

    ctx.strokeStyle = active ? color : color + '50';
    ctx.lineWidth   = active ? 2.5 : 1;
    ctx.beginPath(); ctx.moveTo(x+w-1, y); ctx.lineTo(x+w-1, y+h); ctx.stroke();

    ctx.font      = active ? FONT_ACTIVE : FONT_NORM;
    ctx.fillStyle = active ? color : color + 'cc';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 4; i++) {
      const v  = yMin + (yMax - yMin) * (1 - i/4);
      const py = y + i/4 * h;
      ctx.fillText(fmtVal(v), x + w - 5, Math.max(y + 11, Math.min(y + h - 3, py + 4)));
      ctx.strokeStyle = color + '25'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x+w-5, py); ctx.lineTo(x+w-1, py); ctx.stroke();
    }
    if (locked) {
      ctx.font = '9px sans-serif'; ctx.fillStyle = color + '99'; ctx.textAlign = 'left';
      ctx.fillText('🔒', x+2, y+12);
    }
    ctx.textAlign = 'left';
  }

  function drawXAxis(ctx, x, y, w, h, vS, vE, winSec) {
    ctx.fillStyle = '#0a0e15';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x+w, y); ctx.stroke();

    const step  = gridStep(vE - vS);
    const first = Math.ceil(vS / step) * step;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font      = FONT_NORM;
    ctx.textAlign = 'center';
    for (let ts = first; ts <= vE; ts += step) {
      const px = x + (ts - vS)/(vE - vS) * w;
      const d  = new Date(ts);
      const lb = winSec <= 120
        ? d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
        : d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
      ctx.fillText(lb, px, y + 17);
    }
    ctx.textAlign = 'left';
  }

  // ── Утилиты ──────────────────────────────────────────────────────────

  function getGroupTags(group, project) {
    return (group?.tagIds || []).map(id => project?.tags?.find(t => t.id === id)).filter(Boolean);
  }

  function getVisibleTags(gid) {
    const proj  = window._state?.project;
    const strip = _strips.get(gid);
    if (!proj || !strip) return [];
    const group = proj.groups.find(g => g.id === gid);
    if (!group) return [];
    return getGroupTags(group, proj).filter(t => {
      if (t.isEnabled === false) return false;
      const m = _tagMeta.get(t.id);
      return m && !m.hidden;
    });
  }

  function gridStep(dur) {
    for (const s of [200,500,1000,2000,5000,10000,15000,30000,60000,120000,300000])
      if (dur/s <= 8) return s;
    return 60000;
  }

  function fmtVal(v) {
    const a = Math.abs(v);
    if (!a)     return '0';
    if (a>=1e4) return (v/1000).toFixed(0)+'k';
    if (a>=1e3) return (v/1000).toFixed(1)+'k';
    if (a>=100) return Math.round(v)+'';
    if (a>=10)  return v.toFixed(1);
    return v.toFixed(2);
  }

  function fmtWin(s) { return s >= 60 ? Math.round(s/60)+'м' : s+'с'; }
  function clampWin(s) { return Math.max(5, Math.min(300, s)); }
  function updateWinLabel(gid, s) {
    const el = document.getElementById(`trend-win-${gid}`);
    if (el) el.textContent = fmtWin(s);
  }

  function escH(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function setupResizer(el, wrap, gid) {
    let sy, sh;
    el.addEventListener('mousedown', e => {
      sy = e.clientY; sh = wrap.clientHeight;
      const mv = ev => {
        const h = Math.max(MIN_STRIP_H, sh + ev.clientY - sy);
        wrap.style.height = h + 'px';
        const s = _strips.get(gid); if (s) s.height = h;
      };
      const up = () => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  // ── Публичный API ─────────────────────────────────────────────────────

  return {
    show()  { _visible = true;  _shown = null; init(); },
    hide()  { _visible = false; stopRendering(); },
    push,
    rebuild
  };

})();
