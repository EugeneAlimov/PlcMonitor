// ══════════════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ ДЕРЕВО ТЕГОВ
// Рендерит только видимые строки (~30 из 300 000)
// Загрузка мгновенная независимо от размера проекта
// ══════════════════════════════════════════════════════════════

const VTree = (() => {
  const ROW_H    = 24;    // высота строки в px
  const OVERSCAN = 5;     // дополнительные строки сверху/снизу

  // Плоский массив всех видимых узлов
  let _flat     = [];
  // Набор раскрытых узлов (по id)
  let _expanded = new Set();
  // Исходные данные
  let _sources  = [];
  let _results  = {};
  // Контейнер
  let _viewport = null;
  let _inner    = null;
  // Callback для добавления тега
  let _onAdd    = null;

  // ── Типы узлов ──────────────────────────────────────────
  const T = {
    PLC:      'plc',
    TT_GROUP: 'tt_group',
    TT:       'tt',
    TAG:      'tag',
    DB_GROUP: 'db_group',
    DB:       'db',
    MEMBER:   'member',
    FB_GROUP: 'fb_group',
    FB:       'fb',
  };

  // ── Построение плоского дерева ──────────────────────────
  function buildFlat() {
    _flat = [];

    for (const plc of _sources) {
      const scan = _results[plc.id];
      const plcId = `plc_${plc.id}`;

      if (!scan) {
        _flat.push({ id: plcId, type: T.PLC, label: plc.name || plc.ipAddress,
          hint: 'Не просканирован', depth: 0, hasChildren: false, plc });
        continue;
      }

      _flat.push({ id: plcId, type: T.PLC, label: plc.name || scan.plcName,
        depth: 0, hasChildren: true, plc, scan });

      if (!_expanded.has(plcId)) continue;

      // Tag Tables
      if (scan.tagTables?.length > 0) {
        const ttId = `${plcId}_tt`;
        _flat.push({ id: ttId, type: T.TT_GROUP,
          label: `Таблицы тегов`, hint: `${scan.tagTables.length}`,
          depth: 1, hasChildren: true });

        if (_expanded.has(ttId)) {
          for (let ti = 0; ti < scan.tagTables.length; ti++) {
            const table = scan.tagTables[ti];
            const tId   = `${ttId}_${ti}`;
            _flat.push({ id: tId, type: T.TT,
              label: table.name, hint: `${table.tags?.length||0} тегов`,
              depth: 2, hasChildren: (table.tags?.length > 0), table });

            if (_expanded.has(tId)) {
              for (const tag of table.tags || []) {
                _flat.push({ id: `${tId}_${tag.name}`, type: T.TAG,
                  label: tag.name, hint: tag.dataType,
                  depth: 3, hasChildren: false, tag, plcId: plc.id });
              }
            }
          }
        }
      }

      // Data Blocks
      if (scan.dataBlocks?.length > 0) {
        const dbgId = `${plcId}_dbg`;
        _flat.push({ id: dbgId, type: T.DB_GROUP,
          label: `Data Blocks`, hint: `${scan.dataBlocks.length}`,
          depth: 1, hasChildren: true });

        if (_expanded.has(dbgId)) {
          for (let di = 0; di < scan.dataBlocks.length; di++) {
            const db   = scan.dataBlocks[di];
            const dbId = `${dbgId}_${di}`;
            const opt  = db.isOptimized ? '[OPT]' : '[STD]';
            const inst = db.isInstanceDb ? ` ↪${db.instanceOfFb}` : '';
            _flat.push({ id: dbId, type: T.DB,
              label: `DB${db.number} "${db.name}"`, hint: `${opt}${inst}`,
              depth: 2, hasChildren: (db.members?.length > 0), db });

            if (_expanded.has(dbId)) {
              flattenMembers(_flat, db.members || [], 3, plc.id, dbId);
            }
          }
        }
      }

      // Function Blocks
      if (scan.functionBlocks?.length > 0) {
        const fbgId = `${plcId}_fbg`;
        _flat.push({ id: fbgId, type: T.FB_GROUP,
          label: `Function Blocks`, hint: `${scan.functionBlocks.length}`,
          depth: 1, hasChildren: true });

        if (_expanded.has(fbgId)) {
          for (let fi = 0; fi < scan.functionBlocks.length; fi++) {
            const fb   = scan.functionBlocks[fi];
            const fbId = `${fbgId}_${fi}`;
            const hasS = fb.static?.length > 0;
            _flat.push({ id: fbId, type: T.FB,
              label: `FB${fb.number} "${fb.name}"`,
              depth: 2, hasChildren: hasS, fb });

            if (_expanded.has(fbId) && hasS) {
              for (const tag of fb.static) {
                _flat.push({ id: `${fbId}_${tag.name}`, type: T.TAG,
                  label: tag.name, hint: tag.dataType,
                  depth: 3, hasChildren: false, tag, plcId: plc.id });
              }
            }
          }
        }
      }
    }

    // Обновляем счётчик
    let total = 0;
    for (const s of _sources) {
      const sc = _results[s.id];
      if (!sc) continue;
      sc.tagTables?.forEach(t => total += t.tags?.length||0);
      sc.dataBlocks?.forEach(d => total += countMembersDeep(d.members||[]));
    }
    const badge = document.getElementById('tree-badge');
    if (badge) badge.textContent = total;
  }

  function flattenMembers(flat, members, depth, plcId, parentId) {
    for (let mi = 0; mi < members.length; mi++) {
      const m    = members[mi];
      const mId  = `${parentId}_m${mi}`;
      const hasC = m.children?.length > 0;
      flat.push({ id: mId, type: T.MEMBER,
        label: m.name, hint: m.dataType,
        depth, hasChildren: hasC, member: m, plcId });

      if (hasC && _expanded.has(mId)) {
        flattenMembers(flat, m.children, depth + 1, plcId, mId);
      }
    }
  }

  function countMembersDeep(members) {
    let n = 0;
    for (const m of members) {
      if (m.children?.length > 0) n += countMembersDeep(m.children);
      else n++;
    }
    return n;
  }

  // ── Рендер видимых строк ─────────────────────────────────
  function render() {
    if (!_viewport || !_inner) return;

    const scrollTop  = _viewport.scrollTop;
    const viewH      = _viewport.clientHeight;
    const totalH     = _flat.length * ROW_H;

    _inner.style.height = totalH + 'px';

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const endIdx   = Math.min(_flat.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

    // Убираем строки вне диапазона
    for (const el of Array.from(_inner.children)) {
      const idx = parseInt(el.dataset.idx);
      if (idx < startIdx || idx >= endIdx) el.remove();
    }

    // Добавляем новые строки
    const existing = new Set(Array.from(_inner.children).map(el => parseInt(el.dataset.idx)));

    for (let i = startIdx; i < endIdx; i++) {
      if (existing.has(i)) continue;
      const node = _flat[i];
      const el   = makeRow(node, i);
      // Вставляем в правильную позицию
      let inserted = false;
      for (const child of _inner.children) {
        if (parseInt(child.dataset.idx) > i) {
          _inner.insertBefore(el, child);
          inserted = true;
          break;
        }
      }
      if (!inserted) _inner.appendChild(el);
    }
  }

  // ── Создание строки ──────────────────────────────────────
  function makeRow(node, idx) {
    const el = document.createElement('div');
    el.className   = 'tree-node';
    el.dataset.idx = idx;
    el.dataset.id  = node.id;
    el.style.cssText = `
      position: absolute;
      top: ${idx * ROW_H}px;
      left: 0; right: 0;
      height: ${ROW_H}px;
      padding-left: ${node.depth * 14 + 6}px;
      display: flex; align-items: center; gap: 4px;
    `;

    // Шеврон
    const chev = document.createElement('span');
    chev.className = 'tree-chevron' + (node.hasChildren ? '' : ' leaf');
    if (node.hasChildren) {
      chev.textContent = _expanded.has(node.id) ? '▼' : '▶';
    }
    el.appendChild(chev);

    // Иконка
    const icon = document.createElement('span');
    icon.className   = 'tree-icon';
    icon.textContent = getIcon(node.type);
    el.appendChild(icon);

    // Метка
    const label = document.createElement('span');
    label.className   = 'tree-label';
    label.textContent = node.label;
    if (node.hint) {
      const h = document.createElement('span');
      h.className   = 'type-hint';
      h.textContent = ' ' + node.hint;
      label.appendChild(h);
    }
    el.appendChild(label);

    // Кнопка [+] для тегов
    const canAdd = node.type === T.TAG || node.type === T.MEMBER;
    if (canAdd) {
      const btn = document.createElement('button');
      btn.className   = 'tree-add-btn';
      btn.textContent = '+';
      btn.onclick = e => {
        e.stopPropagation();
        if (_onAdd) _onAdd(node.plcId, node.tag || node.member);
      };
      el.appendChild(btn);
    }

    // Клик — раскрыть/свернуть
    if (node.hasChildren) {
      el.addEventListener('click', () => toggle(node.id));
    }

    return el;
  }

  function getIcon(type) {
    return {
      [T.PLC]:      '🖥',
      [T.TT_GROUP]: '📋',
      [T.TT]:       '📄',
      [T.TAG]:      '🏷',
      [T.DB_GROUP]: '📦',
      [T.DB]:       '🗄',
      [T.MEMBER]:   '●',
      [T.FB_GROUP]: '🔷',
      [T.FB]:       '⬡',
    }[type] || '●';
  }

  function toggle(id) {
    if (_expanded.has(id)) _expanded.delete(id);
    else                   _expanded.add(id);
    buildFlat();
      // Очищаем все существующие строки чтобы render() перерисовал с нуля
    _inner.innerHTML = '';
    render();
  }

  // ── Поиск ────────────────────────────────────────────────
  let _searchQuery = '';
  let _searchFlat  = null;

  function search(query) {
    _searchQuery = query.toLowerCase().trim();
    if (!_searchQuery) {
      _searchFlat = null;
      buildFlat();
      render();
      return;
    }

    // Для поиска показываем только совпадения из всех данных
    _searchFlat = [];
    for (const plc of _sources) {
      const scan = _results[plc.id];
      if (!scan) continue;

      // Ищем по тегам
      for (const table of scan.tagTables || []) {
        for (const tag of table.tags || []) {
          if (tag.name.toLowerCase().includes(_searchQuery)) {
            _searchFlat.push({ id: `s_${plc.id}_tt_${tag.name}`, type: T.TAG,
              label: tag.name, hint: tag.dataType,
              depth: 0, hasChildren: false, tag, plcId: plc.id });
          }
        }
      }

      for (const db of scan.dataBlocks || []) {
        searchMembers(_searchFlat, db.members || [], plc.id);
      }
    }

    renderSearch();
  }

  function searchMembers(result, members, plcId) {
    for (const m of members) {
      if (m.name.toLowerCase().includes(_searchQuery)) {
        result.push({ id: `s_${plcId}_${m.name}_${Math.random()}`, type: T.MEMBER,
          label: m.name, hint: `${m.dataType}`,
          depth: 0, hasChildren: false, member: m, plcId });
      }
      if (m.children?.length > 0) searchMembers(result, m.children, plcId);
    }
  }

  function renderSearch() {
    if (!_inner) return;
    _inner.innerHTML = '';
    _inner.style.height = (_searchFlat.length * ROW_H) + 'px';
    const badge = document.getElementById('tree-badge');
    if (badge) badge.textContent = `🔍 ${_searchFlat.length}`;

    for (let i = 0; i < Math.min(_searchFlat.length, 200); i++) {
      const el = makeRow(_searchFlat[i], i);
      el.style.position = 'absolute';
      el.style.top      = (i * ROW_H) + 'px';
      _inner.appendChild(el);
    }

    if (_searchFlat.length > 200) {
      const hint = document.createElement('div');
      hint.style.cssText = `position:absolute;top:${200*ROW_H}px;padding:8px;font-size:11px;color:var(--text3)`;
      hint.textContent = `... ещё ${_searchFlat.length - 200} совпадений — уточните запрос`;
      _inner.appendChild(hint);
    }
  }

  // ── Публичный API ────────────────────────────────────────
  return {
    init(viewportEl, sources, results, onAddCallback) {
      _viewport = viewportEl;
      _sources  = sources;
      _results  = results;
      _onAdd    = onAddCallback;
      _expanded = new Set();

      // Внутренний контейнер с абсолютным позиционированием
      _inner = document.createElement('div');
      _inner.style.cssText = 'position:relative;width:100%;';
      _viewport.innerHTML  = '';
      _viewport.style.cssText = 'overflow-y:auto;flex:1;position:relative;';
      _viewport.appendChild(_inner);

      buildFlat();
      render();

      _viewport.addEventListener('scroll', () => render(), { passive: true });

     //ДОБАВИТЬ: принудительный ре-рендер после отрисовки браузера
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        render();
        });
      });
    },

    refresh(sources, results) {
      _sources = sources;
      _results = results;
      if (_searchQuery) search(_searchQuery);
      else { 
        buildFlat();
          // Очищаем все существующие строки чтобы render() перерисовал с нуля
        _inner.innerHTML = '';
        render(); 
      }
    },

    search(query) {
      if (_searchFlat !== null && !query) {
        _searchFlat = null;
        buildFlat();
        render();
      } else {
        search(query);
      }
    }
  };
})();