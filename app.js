/* ============================================================
   Семейное древо — приложение
   Люди, родственные связи, localStorage, импорт/экспорт, UI.
   Все данные хранятся только в браузере пользователя.
   ============================================================ */
'use strict';

(function () {
  // ==================== ХРАНИЛИЩА ====================
  var DATA_KEY = 'familyTree.data.v1';
  var DEMO_KEY = 'familyTree.demo.v1';
  var UI_KEY = 'familyTree.ui.v1';
  var BROKEN_KEY = 'familyTree.broken.v1';

  var SUBTYPES = {
    parent: ['bio', 'adoptive', 'step'],
    spouse: ['married', 'partner'],
    sibling: ['bio', 'half'],
    unknown: ['unconfirmed']
  };
  var REL_TYPES = ['parent', 'spouse', 'sibling', 'unknown'];
  var DATA_VERSION = 2;
  var WEEK = 7 * 24 * 60 * 60 * 1000;

  function blankData() {
    return { version: DATA_VERSION, people: [], relations: [], positions: {}, freeLines: [], appearance: { relations: {} } };
  }

  // ==================== СОСТОЯНИЕ ====================
  var state = {
    mode: 'real',
    data: blankData(),
    ui: {},
    selection: null,
    multi: new Set(),
    tool: 'move',
    lineStart: null,
    dragCtx: null,
    filterGens: null,
    search: '',
    collapsed: new Set(),
    layout: null,
    genMap: new Map(),
    history: [],
    future: []
  };

  var view = null;
  var esc = FT.escapeHtml;

  // ==================== МИНИ-УТИЛИТЫ ====================
  function $(id) { return document.getElementById(id); }
  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function str(v) { return v == null ? '' : String(v); }
  function gclass(gen) { return 'g' + (((gen % 6) + 6) % 6); }
  function esc2(s) { return esc(s); }

  function isNarrow() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width:900px)').matches); }
    catch (e) { return false; }
  }
  function closeSidebar() {
    var sb = $('sidebar');
    if (sb) sb.classList.remove('open');
    var bd = $('sideBackdrop');
    if (bd) bd.hidden = true;
  }

  function toast(msg, type) {
    var host = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 260);
    }, type === 'err' ? 4200 : 2600);
  }

  function loadJSON(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  function download(filename, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  // ==================== ДАННЫЕ И ХРАНЕНИЕ ====================
  function dataKey() { return state.mode === 'demo' ? DEMO_KEY : DATA_KEY; }

  function loadUI() {
    var u = loadJSON(UI_KEY) || {};
    state.ui = {
      theme: u.theme || null,
      mode: u.mode === 'demo' ? 'demo' : 'real',
      seenWelcome: !!u.seenWelcome,
      lastExport: u.lastExport || 0,
      lastRemind: u.lastRemind || 0,
      collapse: u.collapse && typeof u.collapse === 'object' ? u.collapse : {}
    };
  }
  function saveUI() { saveJSON(UI_KEY, state.ui); }

  function loadCollapsed() {
    var c = (state.ui.collapse || {})[state.mode] || [];
    state.collapsed = new Set(Array.isArray(c) ? c : []);
  }
  function saveCollapsed() {
    state.ui.collapse = state.ui.collapse || {};
    state.ui.collapse[state.mode] = Array.from(state.collapsed);
    saveUI();
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!saveJSON(dataKey(), state.data)) {
      toast('Не удалось сохранить: возможно, закончилось место в браузере', 'err');
    }
    if (state.mode === 'real' && window.Cloud && Cloud.isActive()) {
      Cloud.save(state.data);
    }
  }

  function loadData() {
    var raw = loadJSON(dataKey());
    if (state.mode === 'demo') {
      if (!raw) { state.data = demoData(); saveNow(); return; }
    }
    if (!raw) { state.data = blankData(); return; }
    var res = validateData(raw);
    if (res.errors.length) {
      saveJSON(BROKEN_KEY, raw);
      state.data = blankData();
      toast('Данные повреждены — сохранена копия, древо пустое', 'err');
      return;
    }
    state.data = res.data;
  }

  // ==================== ВАЛИДАЦИЯ ====================
  function validateData(obj) {
    var errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { errors: ['Файл не похож на резервную копию семейного древа.'], data: blankData() };
    }
    if (!Array.isArray(obj.people)) {
      return { errors: ['В файле нет списка людей (people).'], data: blankData() };
    }

    var people = [];
    var ids = new Set();
    obj.people.forEach(function (p, i) {
      if (!p || typeof p !== 'object') { errors.push('Человек №' + (i + 1) + ' — не объект.'); return; }
      var id = typeof p.id === 'string' && p.id ? p.id : uid('p');
      if (ids.has(id)) { errors.push('Повторяющийся идентификатор: ' + id); return; }
      ids.add(id);
      people.push({
        id: id,
        name: str(p.name).slice(0, 120),
        surname: str(p.surname).slice(0, 120),
        maiden: str(p.maiden).slice(0, 120),
        gender: (p.gender === 'm' || p.gender === 'f') ? p.gender : '',
        birthDate: str(p.birthDate).slice(0, 60),
        birthPlace: str(p.birthPlace).slice(0, 160),
        deathDate: str(p.deathDate).slice(0, 60),
        deathPlace: str(p.deathPlace).slice(0, 160),
        profession: str(p.profession).slice(0, 160),
        bio: str(p.bio).slice(0, 4000),
        notes: str(p.notes).slice(0, 4000),
        photo: typeof p.photo === 'string' ? p.photo : '',
        createdAt: p.createdAt || Date.now()
      });
    });

    var relations = [];
    var seen = new Set();
    var rawR = Array.isArray(obj.relations) ? obj.relations : [];
    rawR.forEach(function (r, i) {
      if (!r || typeof r !== 'object') { errors.push('Связь №' + (i + 1) + ' — не объект.'); return; }
      var type = r.type;
      if (REL_TYPES.indexOf(type) < 0) {
        errors.push('Связь №' + (i + 1) + ': неизвестный тип «' + str(type) + '».');
        return;
      }
      if (!ids.has(r.a) || !ids.has(r.b)) {
        errors.push('Связь №' + (i + 1) + ' ссылается на несуществующего человека.');
        return;
      }
      if (r.a === r.b) { errors.push('Связь №' + (i + 1) + ': человек связан сам с собой.'); return; }
      var sub = SUBTYPES[type].indexOf(r.subtype) >= 0 ? r.subtype : SUBTYPES[type][0];
      var symmetric = (type === 'spouse' || type === 'sibling' || type === 'unknown');
      var key = type + ':' + (symmetric ? [r.a, r.b].sort().join('|') : (r.a + '>' + r.b));
      if (seen.has(key)) return;
      seen.add(key);
      relations.push({ id: typeof r.id === 'string' && r.id ? r.id : uid('r'), type: type, subtype: sub, a: r.a, b: r.b });
    });

    // координаты карточек (свободное расположение)
    var positions = {};
    if (obj.positions && typeof obj.positions === 'object' && !Array.isArray(obj.positions)) {
      Object.keys(obj.positions).forEach(function (id) {
        if (!ids.has(id)) return;
        var pos = obj.positions[id];
        if (pos && isFinite(pos.x) && isFinite(pos.y)) positions[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
      });
    }

    // свободные (декоративные) линии
    var freeLines = [];
    var rawF = Array.isArray(obj.freeLines) ? obj.freeLines : [];
    rawF.forEach(function (fl) {
      if (!fl || typeof fl !== 'object') return;
      var x1 = Number(fl.x1), y1 = Number(fl.y1), x2 = Number(fl.x2), y2 = Number(fl.y2);
      if (![x1, y1, x2, y2].every(isFinite)) return;
      freeLines.push({
        id: typeof fl.id === 'string' && fl.id ? fl.id : uid('fl'),
        x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2),
        color: typeof fl.color === 'string' ? fl.color.slice(0, 40) : '',
        width: isFinite(fl.width) ? Math.max(1, Math.min(12, fl.width)) : 2,
        dash: Array.isArray(fl.dash) ? fl.dash.filter(function (n) { return isFinite(n) && n > 0; }).slice(0, 4) : [],
        curve: isFinite(fl.curve) ? Math.max(-400, Math.min(400, fl.curve)) : 0,
        label: str(fl.label).slice(0, 60)
      });
    });

    // настройки внешнего вида связей
    var appearance = { relations: {} };
    if (obj.appearance && typeof obj.appearance === 'object' && obj.appearance.relations && typeof obj.appearance.relations === 'object') {
      Object.keys(obj.appearance.relations).forEach(function (rid) {
        if (!relations.some(function (r) { return r.id === rid; })) return;
        var s = obj.appearance.relations[rid];
        if (!s || typeof s !== 'object') return;
        var out = {};
        if (typeof s.color === 'string' && s.color) out.color = s.color.slice(0, 40);
        if (isFinite(s.width)) out.width = Math.max(1, Math.min(12, s.width));
        if (Array.isArray(s.dash)) out.dash = s.dash.filter(function (n) { return isFinite(n) && n > 0; }).slice(0, 4);
        if (typeof s.label === 'string' && s.label) out.label = s.label.slice(0, 60);
        if (Object.keys(out).length) appearance.relations[rid] = out;
      });
    }

    var cycle = findParentCycle(people, relations);
    if (cycle) errors.push('Обнаружен цикл в отношениях родитель — ребёнок: ' + cycle.join(' → '));

    return {
      errors: errors,
      data: {
        version: DATA_VERSION,
        people: people,
        relations: relations,
        positions: positions,
        freeLines: freeLines,
        appearance: appearance
      }
    };
  }

  function findParentCycle(people, relations) {
    var byId = new Map(people.map(function (p) { return [p.id, p]; }));
    var children = new Map();
    relations.forEach(function (r) {
      if (r.type !== 'parent' || r.subtype === 'step') return;
      var arr = children.get(r.a) || [];
      arr.push(r.b);
      children.set(r.a, arr);
    });
    var WHITE = 0, GRAY = 1, BLACK = 2;
    var color = new Map();
    people.forEach(function (p) { color.set(p.id, WHITE); });
    var stack = [];
    var found = null;

    function dfs(id) {
      color.set(id, GRAY);
      stack.push(id);
      var kids = children.get(id) || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (color.get(c) === GRAY) {
          var idx = stack.indexOf(c);
          found = stack.slice(idx).concat([c]);
          return true;
        }
        if (color.get(c) === WHITE && dfs(c)) return true;
      }
      stack.pop();
      color.set(id, BLACK);
      return false;
    }

    for (var i = 0; i < people.length; i++) {
      if (color.get(people[i].id) === WHITE && dfs(people[i].id)) break;
    }
    if (!found) return null;
    return found.map(function (id) { var p = byId.get(id); return p ? FT.personName(p) : id; });
  }

  // ==================== ДОСТУП К ДАННЫМ ====================
  function getPerson(id) {
    return state.data.people.find(function (p) { return p.id === id; });
  }
  function parentLinks(id) { return state.data.relations.filter(function (r) { return r.type === 'parent' && r.b === id; }); }
  function childLinks(id) { return state.data.relations.filter(function (r) { return r.type === 'parent' && r.a === id; }); }
  function spouseLinks(id) {
    return state.data.relations.filter(function (r) { return r.type === 'spouse' && (r.a === id || r.b === id); });
  }
  function otherOf(link, id) { return link.a === id ? link.b : link.a; }

  function siblingsOf(id) {
    var res = [];
    var seen = new Set();
    state.data.relations.forEach(function (r) {
      if (r.type !== 'sibling') return;
      if (r.a !== id && r.b !== id) return;
      var o = r.a === id ? r.b : r.a;
      var p = getPerson(o);
      if (p && !seen.has(o)) { seen.add(o); res.push(p); }
    });
    var mine = new Set(parentLinks(id).filter(function (l) { return l.subtype !== 'step'; }).map(function (l) { return l.a; }));
    if (mine.size) {
      state.data.people.forEach(function (p) {
        if (p.id === id || seen.has(p.id)) return;
        var shares = parentLinks(p.id).some(function (l) { return l.subtype !== 'step' && mine.has(l.a); });
        if (shares) { seen.add(p.id); res.push(p); }
      });
    }
    return res;
  }

  function isDescendant(ancestorId, maybeDesc) {
    var stack = [ancestorId], seen = new Set();
    while (stack.length) {
      var x = stack.pop();
      if (x === maybeDesc) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      childLinks(x).forEach(function (l) { if (l.subtype !== 'step') stack.push(l.b); });
    }
    return false;
  }

  function personMeta(p) {
    var y = FT.personYears(p);
    if (y) return y;
    if (p.profession) return p.profession;
    if (p.maiden) return 'урожд. ' + p.maiden;
    return 'нет данных';
  }

  // ==================== CRUD ====================
  function addPerson(fields) {
    var p = {
      id: uid('p'), name: '', surname: '', maiden: '', gender: '', birthDate: '',
      birthPlace: '', deathDate: '', deathPlace: '', profession: '', bio: '',
      notes: '', photo: '', createdAt: Date.now()
    };
    Object.assign(p, fields || {});
    state.data.people.push(p);
    return p;
  }
  function updatePerson(id, fields) {
    var p = getPerson(id);
    if (p) Object.assign(p, fields);
  }
  function deletePerson(id) {
    state.data.people = state.data.people.filter(function (p) { return p.id !== id; });
    state.data.relations = state.data.relations.filter(function (r) { return r.a !== id && r.b !== id; });
    if (state.data.positions) delete state.data.positions[id];
    pruneAppearance();
  }
  function pruneAppearance() {
    if (!state.data.appearance || !state.data.appearance.relations) return;
    var rels = state.data.appearance.relations;
    Object.keys(rels).forEach(function (rid) {
      if (!state.data.relations.some(function (r) { return r.id === rid; })) delete rels[rid];
    });
  }
  function addRelation(type, subtype, a, b) {
    if (!a || !b || a === b) return null;
    if (REL_TYPES.indexOf(type) < 0) return null;
    var sym = (type === 'spouse' || type === 'sibling' || type === 'unknown');
    var dup = state.data.relations.some(function (r) {
      if (r.type !== type) return false;
      if (sym) return (r.a === a && r.b === b) || (r.a === b && r.b === a);
      return r.a === a && r.b === b;
    });
    if (dup) return null;
    var r = { id: uid('r'), type: type, subtype: subtype, a: a, b: b };
    state.data.relations.push(r);
    return r;
  }
  function removeRelation(id) {
    state.data.relations = state.data.relations.filter(function (r) { return r.id !== id; });
    if (state.data.appearance && state.data.appearance.relations) delete state.data.appearance.relations[id];
  }

  // ==================== ИСТОРИЯ (UNDO / REDO) ====================
  function serialize() { return JSON.stringify(state.data); }
  function pushHistory() {
    state.history.push(serialize());
    if (state.history.length > 80) state.history.shift();
    state.future.length = 0;
    updateHistoryUI();
  }
  function commit(mutator) {
    pushHistory();
    mutator();
    saveNow();
    recompute();
    renderBanner();
  }
  function undo() {
    if (!ensureEdit()) return;
    if (!state.history.length) { toast('Нечего отменять', 'warn'); return; }
    state.future.push(serialize());
    state.data = JSON.parse(state.history.pop());
    afterHistory();
  }
  function redo() {
    if (!ensureEdit()) return;
    if (!state.future.length) { toast('Нечего повторять', 'warn'); return; }
    state.history.push(serialize());
    state.data = JSON.parse(state.future.pop());
    afterHistory();
  }
  function afterHistory() {
    if (state.selection && !getPerson(state.selection)) state.selection = null;
    state.multi = new Set(Array.from(state.multi).filter(function (id) { return !!getPerson(id); }));
    state.collapsed = new Set(Array.from(state.collapsed).filter(function (id) { return !!getPerson(id); }));
    state.lineStart = null;
    if (view) view.clearPreview();
    saveNow();
    recompute();
    renderBanner();
    updateHistoryUI();
  }
  function updateHistoryUI() {
    var u = $('toolUndo'), r = $('toolRedo');
    if (u) u.disabled = !state.history.length || !canEdit();
    if (r) r.disabled = !state.future.length || !canEdit();
  }

  // ==================== ПЕРЕРИСОВКА ====================
  function recompute(opts) {
    opts = opts || {};
    state.layout = FT.computeLayout(state.data, state.collapsed);
    var full = FT.computeLayout(state.data, []);
    state.genMap = new Map(full.nodes.map(function (n) { return [n.id, n.gen]; }));
    var byId = new Map(state.data.people.map(function (p) { return [p.id, p]; }));
    view.setModel(state.layout, { byId: byId, selectedIds: state.multi, filterGens: state.filterGens });
    if (!opts.silent) {
      renderList();
      renderDetails();
      updateEmpty();
    }
  }

  function relayout() {
    state.layout = FT.computeLayout(state.data, state.collapsed);
    var byId = new Map(state.data.people.map(function (p) { return [p.id, p]; }));
    view.setModel(state.layout, { byId: byId, selectedIds: state.multi, filterGens: state.filterGens });
  }

  // ==================== ИНСТРУМЕНТЫ (РЕЖИМЫ КАНВЫ) ====================
  function setTool(name) {
    state.tool = name;
    if (name !== 'line') {
      state.lineStart = null;
      if (view) view.clearPreview();
    }
    if (view) view.setTool(name);
    updateToolsUI();
  }
  function updateToolsUI() {
    var btns = document.querySelectorAll('[data-tool]');
    Array.prototype.forEach.call(btns, function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === state.tool);
    });
    var hint = $('toolHint');
    if (hint) {
      hint.textContent = state.tool === 'connect' ? 'Потяните от карточки к карточке, чтобы создать связь'
        : state.tool === 'line' ? 'Кликните две точки, чтобы нарисовать линию'
        : state.tool === 'select' ? 'Рамкой выделите группу карточек'
        : '';
      hint.hidden = state.tool === 'move';
    }
  }
  function resetTransient() {
    state.selection = null;
    state.multi = new Set();
    state.filterGens = null;
    state.lineStart = null;
    state.dragCtx = null;
    state.history = [];
    state.future = [];
    if (view) { view.clearPreview(); }
    setTool('move');
    updateHistoryUI();
  }

  function updateEmpty() {
    $('emptyState').hidden = state.data.people.length > 0;
  }

  function renderList() {
    var q = state.search.trim().toLowerCase();
    var people = state.data.people.slice().sort(function (a, b) {
      return (a.surname + ' ' + a.name).toLowerCase().localeCompare((b.surname + ' ' + b.name).toLowerCase(), 'ru');
    });
    var items = people.filter(function (p) {
      if (!q) return true;
      var hay = (FT.personName(p) + ' ' + (p.maiden || '') + ' ' + (p.profession || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    var countEl = $('peopleCount');
    countEl.textContent = state.data.people.length
      ? 'Родственники · ' + state.data.people.length
      : 'Родственники';
    $('sideEmpty').hidden = !(q && !items.length);

    var html = '';
    items.forEach(function (p) {
      var gen = state.genMap.get(p.id);
      var genCls = gen == null ? '' : gclass(gen);
      var chip = gen == null ? '' : '<span class="pgen">' + (gen + 1) + '</span>';
      html += '<button class="pitem ' + genCls + (state.multi.has(p.id) ? ' sel' : '') + '" data-id="' + esc(p.id) + '">' +
        FT.avatarHtml(p, 'pava') +
        '<div class="pbody"><div class="pname">' + esc(FT.personName(p)) + '</div>' +
        '<div class="pmeta">' + esc(personMeta(p)) + '</div></div>' + chip + '</button>';
    });
    $('peopleList').innerHTML = html;
  }

  function renderDetails() {
    var host = $('detailsHost');
    var p = state.selection ? getPerson(state.selection) : null;
    if (!p) { host.innerHTML = ''; return; }

    var gen = state.genMap.get(p.id);
    var genCls = gen == null ? '' : gclass(gen);
    var years = FT.personYears(p);
    var nameHtml = esc(FT.personName(p));
    var maiden = p.maiden ? '<span style="color:var(--dim);font-weight:500"> (урожд. ' + esc(p.maiden) + ')</span>' : '';

    var info = '';
    function infoLine(k, v) { if (v) info += '<div class="info-line"><span class="k">' + k + '</span><span class="v">' + esc(v) + '</span></div>'; }
    infoLine('Рождение', [p.birthDate, p.birthPlace].filter(Boolean).join(', '));
    infoLine('Смерть', [p.deathDate, p.deathPlace].filter(Boolean).join(', '));
    infoLine('Профессия', p.profession);
    infoLine('Пол', p.gender === 'f' ? 'женский' : p.gender === 'm' ? 'мужской' : '');
    infoLine('Поколение', gen == null ? '' : String(gen + 1));

    var node = null;
    if (state.layout) {
      node = state.layout.nodes.find(function (n) { return n.id === p.id; });
    }
    var canCollapse = node && node.hasChildren;

    var editHtml = canEdit()
      ? '<div class="d-sec"><h4>Действия</h4>' +
        '<div class="btn-row">' +
        '<button class="btn-mini" data-act="connect">Создать связь</button>' +
        '<button class="btn-mini" data-act="edit">Редактировать</button>' +
        '<button class="btn-mini" data-act="duplicate">Дублировать</button>' +
        '<button class="btn-mini" data-act="link">Связать с…</button>' +
        (canCollapse ? '<button class="btn-mini" data-act="collapse">' + (state.collapsed.has(p.id) ? 'Показать ветвь' : 'Свернуть ветвь') + '</button>' : '') +
        '<button class="btn-mini danger" data-act="delete">Удалить</button>' +
        '</div>' +
        '<div class="d-sec" style="margin:12px 0 0"><h4>Добавить</h4>' +
        '<div class="btn-row">' +
        '<button class="btn-mini" data-add="parent">Добавить родителя</button>' +
        '<button class="btn-mini" data-add="child">Добавить ребёнка</button>' +
        '<button class="btn-mini" data-add="spouse">Добавить супруга/партнёра</button>' +
        '<button class="btn-mini" data-add="sibling">Добавить брата/сестру</button>' +
        '</div></div>' +
        '</div>'
      : '';

    var html =
      '<div class="details" data-panel>' +
      '<div class="d-head">' +
      '<div class="d-ava ' + genCls + '">' + avatarInner(p) + '</div>' +
      '<div class="d-title"><h2>' + nameHtml + maiden + '</h2>' +
      '<div class="d-years">' + esc(years || 'годы неизвестны') + '</div></div>' +
      '<button class="icon-btn d-close" data-act="close" title="Закрыть">&#215;</button>' +
      '</div>' +
      '<div class="d-body">' +
      (info ? '<div class="d-sec">' + info + '</div>' : '') +
      (p.bio ? '<div class="d-sec"><h4>Биография и заметки</h4><div class="d-bio">' + esc(p.bio) + '</div></div>' : '') +
      '<div class="d-sec"><h4>Родители</h4><div data-sec="parents"></div></div>' +
      '<div class="d-sec"><h4>Супруги и партнёры</h4><div data-sec="spouses"></div></div>' +
      '<div class="d-sec"><h4>Дети</h4><div data-sec="children"></div></div>' +
      '<div class="d-sec"><h4>Братья и сёстры</h4><div data-sec="siblings"></div></div>' +
      editHtml +
      '</div></div>';

    host.innerHTML = html;

    // наполняем секции связей
    fillParents(p);
    fillSpouses(p);
    fillChildren(p);
    fillSiblings(p);
  }

  function avatarInner(p) {
    if (p.photo) return '<img src="' + esc(p.photo) + '" alt="">';
    return esc(FT.initials(p));
  }

  function relRow(otherId, typeLabel, linkId, genMap) {
    var o = getPerson(otherId);
    if (!o) return '';
    var gen = genMap.get(o.id);
    var genCls = gen == null ? '' : gclass(gen);
    var removeBtn = linkId
      ? '<button class="rox" data-unlink="' + esc(linkId) + '" title="Убрать связь">&#215;</button>'
      : '<button class="rox" style="opacity:.35;pointer-events:none" title="Связь по общим родителям">&#8942;</button>';
    return '<button class="ral ' + genCls + '" data-goto="' + esc(o.id) + '">' +
      FT.avatarHtml(o, 'rava') +
      '<div class="rbody"><div class="rname">' + esc(FT.personName(o)) + '</div>' +
      '<div class="rtype">' + esc(typeLabel) + '</div></div>' + removeBtn + '</button>';
  }

  function fillParents(p) {
    var host = $('detailsHost').querySelector('[data-sec="parents"]');
    var links = parentLinks(p.id);
    host.innerHTML = links.length
      ? links.map(function (l) { return relRow(l.a, parentLabel(l, getPerson(l.a)), l.id, state.genMap); }).join('')
      : emptyRel('Родители не указаны');
  }
  function fillSpouses(p) {
    var host = $('detailsHost').querySelector('[data-sec="spouses"]');
    var links = spouseLinks(p.id);
    host.innerHTML = links.length
      ? links.map(function (l) { var o = otherOf(l, p.id); return relRow(o, spouseLabel(l, getPerson(o)), l.id, state.genMap); }).join('')
      : emptyRel('Нет супругов или партнёров');
  }
  function fillChildren(p) {
    var host = $('detailsHost').querySelector('[data-sec="children"]');
    var links = childLinks(p.id);
    host.innerHTML = links.length
      ? links.map(function (l) { return relRow(l.b, childLabel(l, getPerson(l.b)), l.id, state.genMap); }).join('')
      : emptyRel('Дети не указаны');
  }
  function fillSiblings(p) {
    var host = $('detailsHost').querySelector('[data-sec="siblings"]');
    var sibs = siblingsOf(p.id);
    host.innerHTML = sibs.length
      ? sibs.map(function (s) { return relRow(s.id, siblingLabel(s), null, state.genMap); }).join('')
      : emptyRel('Братья и сёстры не указаны');
  }
  function emptyRel(text) { return '<div style="font-size:12.5px;color:var(--dim);padding:4px 2px">' + esc(text) + '</div>'; }

  function parentLabel(link, rel) {
    var g = rel ? rel.gender : '';
    if (link.subtype === 'adoptive') return g === 'f' ? 'Приёмная мать' : g === 'm' ? 'Приёмный отец' : 'Приёмный родитель';
    if (link.subtype === 'step') return g === 'f' ? 'Мачеха' : g === 'm' ? 'Отчим' : 'Отчим или мачеха';
    return g === 'f' ? 'Мать' : g === 'm' ? 'Отец' : 'Родитель';
  }
  function childLabel(link, rel) {
    var g = rel ? rel.gender : '';
    if (link.subtype === 'adoptive') return g === 'f' ? 'Приёмная дочь' : g === 'm' ? 'Приёмный сын' : 'Приёмный ребёнок';
    if (link.subtype === 'step') return g === 'f' ? 'Падчерица' : g === 'm' ? 'Пасынок' : 'Пасынок или падчерица';
    return g === 'f' ? 'Дочь' : g === 'm' ? 'Сын' : 'Ребёнок';
  }
  function spouseLabel(link, rel) {
    var g = rel ? rel.gender : '';
    if (link.subtype === 'partner') return g === 'f' ? 'Партнёрша' : 'Партнёр';
    return g === 'f' ? 'Супруга' : 'Супруг';
  }
  function siblingLabel(rel) {
    return rel.gender === 'f' ? 'Сестра' : rel.gender === 'm' ? 'Брат' : 'Брат или сестра';
  }

  // ==================== ВЫБОР ====================
  function selectPerson(id, opts) {
    opts = opts || {};
    if (opts.additive && id) {
      if (state.multi.has(id)) state.multi.delete(id);
      else state.multi.add(id);
    } else {
      state.multi = new Set(id ? [id] : []);
    }
    state.selection = id;
    view.setSelection(state.multi);
    renderList();
    renderDetails();
    if (id && opts.center) view.centerOn(id, true);
    if (id && opts.scrollList) scrollListTo(id);
  }
  function scrollListTo(id) {
    var el = $('peopleList').querySelector('[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  function toggleCollapse(id) {
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    saveCollapsed();
    recompute();
  }

  // ==================== МОДАЛЬНЫЕ ОКНА ====================
  function showModal(html, onClose) {
    var host = $('modalHost');
    host.innerHTML = '<div class="modal-backdrop">' + html + '</div>';
    var backdrop = host.firstChild;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      host.innerHTML = '';
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
    var closers = backdrop.querySelectorAll('[data-close]');
    Array.prototype.forEach.call(closers, function (x) { x.addEventListener('click', close); });
    return close;
  }

  function confirmModal(o) {
    return new Promise(function (resolve) {
      var settled = false;
      var settle = function (v) { if (!settled) { settled = true; resolve(v); } };
      var close = showModal(
        '<div class="modal">' +
        '<div class="modal-head"><h3>' + esc(o.title) + '</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
        '<div class="modal-body">' + (o.html || '') + '</div>' +
        '<div class="modal-actions">' + (o.extra || '') +
        '<button class="btn" data-cancel>Отмена</button>' +
        '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" data-ok>' + esc(o.confirmLabel || 'ОК') + '</button>' +
        '</div></div>',
        function () { settle(false); }
      );
      $('modalHost').querySelector('[data-cancel]').addEventListener('click', function () { settle(false); close(); });
      $('modalHost').querySelector('[data-ok]').addEventListener('click', function () { settle(true); close(); });
      if (o.onMount) o.onMount($('modalHost'));
    });
  }

  // ==================== ФОРМА ЧЕЛОВЕКА ====================
  function openPersonForm(opts) {
    if (!ensureEdit()) return;
    opts = opts || {};
    var person = opts.person || null;
    var isEdit = !!person;
    var f = person || { gender: opts.gender || '' };
    var photo = f.photo || '';
    var title = opts.title || (isEdit ? 'Редактировать' : 'Новый родственник');

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>' + esc(title) + '</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body"><form id="personForm">' +
      '<div class="form-grid">' +
      field('Имя', 'name', f.name || '', 'Например: Иван') +
      field('Фамилия', 'surname', f.surname || '', 'Например: Иванов') +
      field('Фамилия при рождении', 'maiden', f.maiden || '', 'девичья фамилия', 'maiden-field') +
      genderField(f.gender || '') +
      field('Дата рождения', 'birthDate', f.birthDate || '', '1954 или 12.03.1954') +
      field('Место рождения', 'birthPlace', f.birthPlace || '', 'город, село…') +
      field('Дата смерти', 'deathDate', f.deathDate || '', 'если применимо') +
      field('Место смерти', 'deathPlace', f.deathPlace || '', '') +
      '<label class="fld span2">Профессия / род занятий<input class="field" name="profession" value="' + esc(f.profession || '') + '" placeholder="Например: учитель, инженер"></label>' +
      '<label class="fld span2">Биография<textarea class="field" name="bio" rows="3" placeholder="Краткая история, факты, воспоминания">' + esc(f.bio || '') + '</textarea></label>' +
      '<label class="fld span2">Заметки<textarea class="field" name="notes" rows="2" placeholder="Любые дополнительные заметки">' + esc(f.notes || '') + '</textarea></label>' +
      '</div>' +
      '<div class="photo-row">' +
      '<div class="photo-prev" id="photoPrev">' + (photo ? '<img src="' + esc(photo) + '" alt="">' : 'Фото') + '</div>' +
      '<div class="photo-actions">' +
      '<button type="button" class="btn-mini" id="photoPick">Загрузить фото</button>' +
      '<button type="button" class="btn-mini" id="photoClear"' + (photo ? '' : ' hidden') + '>Убрать фото</button>' +
      '</div>' +
      '<input type="file" id="photoInput" accept="image/*" hidden>' +
      '</div>' +
      '<div class="help-text">Все поля необязательны — заполните хотя бы имя или фамилию. Даты можно указывать неточно.</div>' +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      '<button type="button" class="btn" data-close>Отмена</button>' +
      '<button type="submit" class="btn primary">Сохранить</button>' +
      '</div>' +
      '</form></div></div>';

    var close = showModal(html);
    var host = $('modalHost');

    // пол
    var genderSeg = host.querySelector('[data-field="gender"]');
    var maidenFld = host.querySelector('.maiden-field');
    // «Девичья фамилия» скрыта только для мужчин. Значение поля не удаляется —
    // input остаётся в форме со своим значением и сохраняется как обычно.
    function syncMaiden() {
      if (maidenFld) maidenFld.hidden = genderSeg.dataset.value === 'm';
    }
    genderSeg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-val]');
      if (!b) return;
      Array.prototype.forEach.call(genderSeg.children, function (c) { c.classList.toggle('on', c === b); });
      genderSeg.dataset.value = b.getAttribute('data-val');
      syncMaiden();
    });
    syncMaiden();

    // фото
    var photoInput = host.querySelector('#photoInput');
    host.querySelector('#photoPick').addEventListener('click', function () { photoInput.click(); });
    var clearBtn = host.querySelector('#photoClear');
    clearBtn.addEventListener('click', function () {
      photo = '';
      host.querySelector('#photoPrev').innerHTML = 'Фото';
      clearBtn.hidden = true;
    });
    photoInput.addEventListener('change', function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      resizeImage(file, function (dataUrl) {
        if (!dataUrl) { toast('Не удалось прочитать изображение', 'err'); return; }
        photo = dataUrl;
        host.querySelector('#photoPrev').innerHTML = '<img src="' + esc(dataUrl) + '" alt="">';
        clearBtn.hidden = false;
      });
    });

    host.querySelector('#personForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var val = function (n) { return (form.elements[n] ? form.elements[n].value : '').trim(); };
      var fields = {
        name: val('name'), surname: val('surname'), maiden: val('maiden'),
        gender: genderSeg.dataset.value || '',
        birthDate: val('birthDate'), birthPlace: val('birthPlace'),
        deathDate: val('deathDate'), deathPlace: val('deathPlace'),
        profession: val('profession'), bio: val('bio'), notes: val('notes'), photo: photo
      };
      if (!fields.name && !fields.surname) {
        toast('Укажите хотя бы имя или фамилию', 'err');
        return;
      }

      pushHistory();
      if (isEdit) {
        updatePerson(person.id, fields);
        save();
        close();
        recompute();
        toast('Сохранено', 'ok');
        return;
      }

      var newP = addPerson(fields);
      applyNewRelation(newP, opts, function () {
        save();
        close();
        recompute();
        selectPerson(newP.id, { center: true, scrollList: true });
        if (state.data.people.length <= 1) view.fit(true);
        toast('Родственник добавлен', 'ok');
      });
    });
  }

  function field(label, name, value, ph, cls) {
    return '<label class="fld' + (cls ? ' ' + cls : '') + '">' + esc(label) + '<input class="field" name="' + name + '" value="' + esc(value) + '" placeholder="' + esc(ph || '') + '"></label>';
  }
  function genderField(value) {
    return '<label class="fld">Пол<div class="seg" data-field="gender" data-value="' + esc(value) + '">' +
      '<button type="button" data-val=""' + (value === '' ? ' class="on"' : '') + '>Не указан</button>' +
      '<button type="button" data-val="f"' + (value === 'f' ? ' class="on"' : '') + '>Женский</button>' +
      '<button type="button" data-val="m"' + (value === 'm' ? ' class="on"' : '') + '>Мужской</button>' +
      '</div></label>';
  }

  function resizeImage(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(null); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null); };
      img.onload = function () {
        var max = 280;
        var w = img.width, h = img.height;
        var scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        var cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try { cb(cv.toDataURL('image/jpeg', 0.82)); } catch (e) { cb(null); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // создаёт связь для только что добавленного человека
  function applyNewRelation(newP, opts, done) {
    var relation = opts.relation;
    var anchor = opts.anchor;
    if (!relation || !anchor) { done(); return; }

    if (relation.act === 'parent') {
      var ok = guardParentLink(newP.id, anchor.id);
      if (!ok.ok) { toast(ok.msg, 'err'); done(); return; }
      addRelation('parent', relation.subtype || 'bio', newP.id, anchor.id);
      done();
    } else if (relation.act === 'child') {
      var ok2 = guardParentLink(anchor.id, newP.id);
      if (!ok2.ok) { toast(ok2.msg, 'err'); done(); return; }
      addRelation('parent', relation.subtype || 'bio', anchor.id, newP.id);
      done();
    } else if (relation.act === 'spouse') {
      addRelation('spouse', relation.subtype || 'married', anchor.id, newP.id);
      var kids = childLinks(anchor.id).filter(function (l) { return l.subtype !== 'step'; });
      if (kids.length) {
        askStepParent(newP, anchor, kids);
      }
      done();
    } else if (relation.act === 'sibling') {
      var plinks = parentLinks(anchor.id).filter(function (l) { return l.subtype !== 'step'; });
      if (plinks.length) {
        // есть родители — новый человек становится их ребёнком (и, значит, братом/сестрой)
        plinks.forEach(function (l) { addRelation('parent', l.subtype, l.a, newP.id); });
      } else {
        // родителей нет или они неизвестны — связываем напрямую как брата/сестру
        addRelation('sibling', relation.subtype || 'bio', anchor.id, newP.id);
      }
      done();
    } else {
      done();
    }
  }

  function askStepParent(spouse, anchor, kids) {
    var label = spouse.gender === 'f' ? 'мачехой' : spouse.gender === 'm' ? 'отчимом' : 'отчимом/мачехой';
    var name = FT.personName(spouse);
    confirmModal({
      title: 'Отчим или мачеха?',
      html: '<p style="font-size:13.5px;margin-bottom:6px">Отметить <b>' + esc(name) + '</b> как ' + label +
        ' для ' + kids.length + ' ' + plural(kids.length, 'ребёнка', 'детей', 'детей') + ' (' +
        esc(FT.personName(anchor)) + ')?</p><p style="font-size:12.5px;color:var(--dim)">Это дополнительная (пунктирная) связь. Можно изменить позже.</p>',
      confirmLabel: 'Отметить'
    }).then(function (yes) {
      if (!yes) return;
      pushHistory();
      kids.forEach(function (l) { addRelation('parent', 'step', spouse.id, l.b); });
      save();
      recompute();
      toast('Отмечено как отчим/мачеха', 'ok');
    });
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function guardParentLink(parentId, childId) {
    if (parentId === childId) return { ok: false, msg: 'Человек не может быть родителем сам себе' };
    if (isDescendant(childId, parentId)) {
      return { ok: false, msg: 'Нельзя: это создаст цикл в родословной' };
    }
    return { ok: true };
  }

  // ==================== МЕНЮ ДОБАВЛЕНИЯ ====================
  function addMenuDefs(category) {
    var defs = {
      parent: [
        { label: 'Мать', act: 'parent', subtype: 'bio', gender: 'f' },
        { label: 'Отец', act: 'parent', subtype: 'bio', gender: 'm' },
        { label: 'Приёмная мать', act: 'parent', subtype: 'adoptive', gender: 'f' },
        { label: 'Приёмный отец', act: 'parent', subtype: 'adoptive', gender: 'm' },
        { label: 'Мачеха', act: 'parent', subtype: 'step', gender: 'f' },
        { label: 'Отчим', act: 'parent', subtype: 'step', gender: 'm' },
        { sep: true },
        { label: 'Связать с существующим…', act: 'link', category: 'parent' }
      ],
      child: [
        { label: 'Сын', act: 'child', subtype: 'bio', gender: 'm' },
        { label: 'Дочь', act: 'child', subtype: 'bio', gender: 'f' },
        { label: 'Приёмный ребёнок', act: 'child', subtype: 'adoptive', gender: '' },
        { label: 'Пасынок', act: 'child', subtype: 'step', gender: 'm' },
        { label: 'Падчерица', act: 'child', subtype: 'step', gender: 'f' },
        { sep: true },
        { label: 'Связать с существующим…', act: 'link', category: 'child' }
      ],
      spouse: [
        { label: 'Супруг / супруга', act: 'spouse', subtype: 'married' },
        { label: 'Партнёр / партнёрша', act: 'spouse', subtype: 'partner' },
        { sep: true },
        { label: 'Связать с существующим…', act: 'link', category: 'spouse' }
      ],
      sibling: [
        { label: 'Брат', act: 'sibling', gender: 'm' },
        { label: 'Сестра', act: 'sibling', gender: 'f' }
      ]
    };
    return defs[category] || defs.parent;
  }

  function openAddMenu(anchorEl, person, category) {
    closePopover();
    var defs = addMenuDefs(category);
    var html = '';
    defs.forEach(function (d, i) {
      if (d.sep) { html += '<div class="msep"></div>'; return; }
      html += '<button class="mitem" data-i="' + i + '">' + esc(d.label) + '</button>';
    });
    var close = showPopover(anchorEl, html, 'left');
    $('popoverHost').querySelector('.popover').addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]');
      if (!b) return;
      var d = defs[parseInt(b.getAttribute('data-i'), 10)];
      close();
      if (d.act === 'link') { openLinkModal(person, d.category); return; }
      if (d.act === 'sibling') {
        // брата/сестру можно добавить и без родителей (когда они неизвестны):
        // связь «брат/сестра» создаётся напрямую.
        openPersonForm({ anchor: person, relation: { act: 'sibling' }, gender: d.gender, title: 'Новый брат или сестра' });
        return;
      }
      var titles = { parent: 'Новый родитель', child: 'Новый ребёнок', spouse: 'Новый супруг/партнёр' };
      openPersonForm({
        anchor: person,
        relation: { act: d.act, subtype: d.subtype, gender: d.gender },
        gender: d.gender,
        title: titles[d.act] + ' — ' + FT.personName(person)
      });
    });
  }

  // ==================== СВЯЗЬ С СУЩЕСТВУЮЩИМ ====================
  function openLinkModal(person, category) {
    var optsList = {
      parent: [
        { label: 'Родитель', subtype: 'bio', inv: true },
        { label: 'Приёмный родитель', subtype: 'adoptive', inv: true },
        { label: 'Отчим или мачеха', subtype: 'step', inv: true }
      ],
      child: [
        { label: 'Ребёнок', subtype: 'bio', inv: false },
        { label: 'Приёмный ребёнок', subtype: 'adoptive', inv: false },
        { label: 'Пасынок или падчерица', subtype: 'step', inv: false }
      ],
      spouse: [
        { label: 'Супруг(а)', subtype: 'married', inv: false, spouse: true },
        { label: 'Партнёр(ша)', subtype: 'partner', inv: false, spouse: true }
      ]
    };
    var list = optsList[category] || optsList.parent;

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Связать с «' + esc(FT.personName(person)) + '»</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<label class="fld">Тип связи' +
      '<select class="field" id="linkType">' +
      list.map(function (o, i) { return '<option value="' + i + '"' + (i === 0 ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="fld">Кого связать?<input class="field" id="linkSearch" placeholder="Поиск по имени…" autocomplete="off"></label>' +
      '<div class="pick-list" id="linkList"></div>' +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      '<button type="button" class="btn" data-close>Отмена</button>' +
      '<button type="button" class="btn primary" id="linkDo">Связать</button>' +
      '</div></div></div>';

    var close = showModal(html);
    var host = $('modalHost');
    var selected = null;

    function renderCandidates() {
      var typeIdx = parseInt(host.querySelector('#linkType').value, 10);
      var opt = list[typeIdx];
      var q = host.querySelector('#linkSearch').value.trim().toLowerCase();
      var people = state.data.people.filter(function (p) {
        if (p.id === person.id) return false;
        if (q && FT.personName(p).toLowerCase().indexOf(q) < 0 && (p.maiden || '').toLowerCase().indexOf(q) < 0) return false;
        // прячем тех, кто уже связан так же
        if (opt.spouse) {
          var dup = spouseLinks(person.id).some(function (l) { return otherOf(l, person.id) === p.id; });
          if (dup) return false;
        } else if (opt.inv) {
          var dup2 = parentLinks(person.id).some(function (l) { return l.a === p.id; });
          if (dup2) return false;
        } else {
          var dup3 = childLinks(person.id).some(function (l) { return l.b === p.id; });
          if (dup3) return false;
        }
        return true;
      });
      var h = '';
      people.forEach(function (p) {
        var gen = state.genMap.get(p.id);
        h += '<button type="button" class="pick-item ' + (gen == null ? '' : gclass(gen)) + (selected === p.id ? ' on' : '') + '" data-pick="' + esc(p.id) + '">' +
          FT.avatarHtml(p, 'pava') +
          '<div><div class="pname">' + esc(FT.personName(p)) + '</div><div class="pmeta">' + esc(personMeta(p)) + '</div></div>' +
          '</button>';
      });
      host.querySelector('#linkList').innerHTML = h || '<div style="padding:12px;color:var(--dim);font-size:13px">Нет подходящих людей</div>';
    }

    host.querySelector('#linkSearch').addEventListener('input', renderCandidates);
    host.querySelector('#linkType').addEventListener('change', function () { selected = null; renderCandidates(); });
    host.querySelector('#linkList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      if (!b) return;
      selected = b.getAttribute('data-pick');
      Array.prototype.forEach.call(host.querySelectorAll('[data-pick]'), function (x) { x.classList.toggle('on', x === b); });
    });

    host.querySelector('#linkDo').addEventListener('click', function () {
      if (!selected) { toast('Выберите человека из списка', 'err'); return; }
      var opt = list[parseInt(host.querySelector('#linkType').value, 10)];
      pushHistory();
      if (opt.spouse) {
        addRelation('spouse', opt.subtype, person.id, selected);
      } else if (opt.inv) {
        if (opt.subtype !== 'step') {
          var g = guardParentLink(selected, person.id);
          if (!g.ok) { toast(g.msg, 'err'); return; }
        }
        addRelation('parent', opt.subtype, selected, person.id);
      } else {
        if (opt.subtype !== 'step') {
          var g2 = guardParentLink(person.id, selected);
          if (!g2.ok) { toast(g2.msg, 'err'); return; }
        }
        addRelation('parent', opt.subtype, person.id, selected);
      }
      save();
      close();
      recompute();
      toast('Связь создана', 'ok');
    });

    renderCandidates();
  }

  // ==================== POPOVER ====================
  function showPopover(anchorEl, html, align) {
    var host = $('popoverHost');
    // Меряем размеры панели в нейтральной позиции. Важно: width:max-content + max-width,
    // иначе у position:fixed с width:auto ширина растягивается до доступной (огромная панель).
    host.innerHTML = '<div class="popover" style="position:fixed;left:0;top:0;visibility:hidden;width:max-content;max-width:calc(100vw - 16px)">' + html + '</div>';
    var pop = host.firstChild;
    var r = anchorEl.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = align === 'right' ? r.right - w : r.left;
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (left < 8) left = 8;
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) { top = r.top - 6 - h; if (top < 8) top = 8; }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';

    function onDoc(e) {
      if (!pop.contains(e.target) && e.target !== anchorEl) closePopover();
    }
    function onKey(e) { if (e.key === 'Escape') closePopover(); }
    setTimeout(function () {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    pop._cleanup = function () {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    return closePopover;
  }
  function closePopover() {
    var host = $('popoverHost');
    var pop = host.firstChild;
    if (pop && pop._cleanup) pop._cleanup();
    host.innerHTML = '';
  }

  // ==================== ГЛАВНОЕ МЕНЮ ====================
  function openMainMenu(anchorEl) {
    closePopover();
    var themeLabel = currentTheme() === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    var demoLabel = state.mode === 'demo' ? 'Выйти из режима примера' : 'Режим примера (демо)';
    var html =
      '<div class="mgroup">Древо</div>' +
      '<button class="mitem" data-a="add"><span class="mico">+</span>Добавить родственника</button>' +
      '<button class="mitem" data-a="link"><span class="mico">&#8734;</span>Связать выбранного с…</button>' +
      '<div class="msep"></div>' +
      '<div class="mgroup">Совместная работа</div>' +
      '<button class="mitem" data-a="collab"><span class="mico">&#9729;</span>Соавторы и доступ</button>' +
      '<button class="mitem" data-a="history"><span class="mico">&#8634;</span>История изменений</button>' +
      '<div class="msep"></div>' +
      '<div class="mgroup">Файл и печать</div>' +
      '<button class="mitem" data-a="export"><span class="mico">&#8595;</span>Экспорт в JSON</button>' +
      '<button class="mitem" data-a="import"><span class="mico">&#8593;</span>Импорт из JSON</button>' +
      '<button class="mitem" data-a="png"><span class="mico">&#9635;</span>Сохранить изображение (PNG)</button>' +
      '<button class="mitem" data-a="print"><span class="mico">&#9113;</span>Печать</button>' +
      '<div class="msep"></div>' +
      '<div class="mgroup">Вид</div>' +
      '<button class="mitem" data-a="arrange"><span class="mico">&#9638;</span>Автоматически расположить древо</button>' +
      '<button class="mitem" data-a="center"><span class="mico">&#9635;</span>Центрировать древо</button>' +
      '<button class="mitem" data-a="fit"><span class="mico">&#9634;</span>Показать всё древо</button>' +
      '<div class="msep"></div>' +
      '<button class="mitem" data-a="filter"><span class="mico">&#9776;</span>Фильтр по поколениям</button>' +
      '<button class="mitem" data-a="theme"><span class="mico">&#9789;</span>' + esc(themeLabel) + '</button>' +
      '<div class="msep"></div>' +
      '<button class="mitem" data-a="demo"><span class="mico">&#9737;</span>' + esc(demoLabel) + '</button>' +
      '<button class="mitem" data-a="about"><span class="mico">?</span>О программе и приватности</button>' +
      '<div class="msep"></div>' +
      '<button class="mitem danger" data-a="clear"><span class="mico">&#215;</span>Очистить древо</button>';

    var close = showPopover(anchorEl, html, 'right');
    $('popoverHost').querySelector('.popover').addEventListener('click', function (e) {
      var b = e.target.closest('[data-a]');
      if (!b) return;
      var a = b.getAttribute('data-a');
      close();
      menuAction(a);
    });
  }

  function menuAction(a) {
    if (a === 'add') {
      if (!state.data.people.length) { openPersonForm({ title: 'Первый человек в древе' }); return; }
      openPersonForm({ title: 'Новый родственник' });
    } else if (a === 'link') {
      if (!state.selection) { toast('Сначала выберите человека', 'warn'); return; }
      openLinkModal(getPerson(state.selection), 'parent');
    }     else if (a === 'collab') { openCollaborators(); }
    else if (a === 'history') { openHistory(); }
    else if (a === 'export') { exportJSON(); }
    else if (a === 'import') { $('importFile').click(); }
    else if (a === 'png') { exportTreePNG(); }
    else if (a === 'print') { printTree(); }
    else if (a === 'filter') { openGenFilter(); }
    else if (a === 'fit') { view.fit(true); }
    else if (a === 'arrange') { arrangeTree(); }
    else if (a === 'center') { centerTree(); }
    else if (a === 'theme') { toggleTheme(); }
    else if (a === 'demo') { state.mode === 'demo' ? exitDemo() : enterDemo(); }
    else if (a === 'about') { openAbout(); }
    else if (a === 'clear') { clearTree(); }
  }

  // ==================== ФИЛЬТР ПОКОЛЕНИЙ ====================
  function openGenFilter() {
    if (!state.layout || !state.layout.nodes.length) { toast('Древо пустое', 'warn'); return; }
    var levels = state.layout.levels;
    var counts = new Array(levels).fill(0);
    state.layout.nodes.forEach(function (n) { counts[n.gen]++; });
    var current = state.filterGens;
    var rows = '';
    for (var i = 0; i < levels; i++) {
      var on = !current || current.has(i);
      rows += '<label style="display:flex;align-items:center;gap:10px;padding:7px 2px;font-size:13.5px;color:var(--txt)">' +
        '<input type="checkbox" data-gen="' + i + '"' + (on ? ' checked' : '') + '>' +
        '<span class="gp-swatch ' + gclass(i) + '"></span>' +
        'Поколение ' + (i + 1) + ' <span style="color:var(--dim)">· ' + counts[i] + ' ' + plural(counts[i], 'человек', 'человека', 'человек') + '</span>' +
        '</label>';
    }
    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Фильтр по поколениям</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<p class="help-text" style="margin:0 0 12px">Отметьте поколения, которые нужно показать. Остальные станут бледными, но не удалятся.</p>' +
      rows +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      '<button type="button" class="btn" id="gfAll">Показать все</button>' +
      '<button type="button" class="btn primary" id="gfApply">Применить</button>' +
      '</div></div></div>';
    var close = showModal(html);
    var host = $('modalHost');
    host.querySelector('#gfAll').addEventListener('click', function () {
      state.filterGens = null;
      view.setFilter(null);
      close();
      toast('Показаны все поколения', 'ok');
    });
    host.querySelector('#gfApply').addEventListener('click', function () {
      var boxes = host.querySelectorAll('[data-gen]');
      var set = new Set();
      var allOn = true;
      Array.prototype.forEach.call(boxes, function (b) {
        if (b.checked) set.add(parseInt(b.getAttribute('data-gen'), 10));
        else allOn = false;
      });
      if (allOn || !set.size) {
        state.filterGens = null;
        view.setFilter(null);
      } else {
        state.filterGens = set;
        view.setFilter(set);
      }
      close();
    });
  }

  // ==================== ТЕМА ====================
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || systemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#121917' : '#2e8b64');
  }
  function toggleTheme() {
    var t = currentTheme() === 'dark' ? 'light' : 'dark';
    state.ui.theme = t;
    saveUI();
    applyTheme(t);
  }

  // ==================== ОБЛАКО / СОВМЕСТНАЯ РАБОТА ====================
  function canEdit() {
    return !(window.Cloud && Cloud.isActive()) || Cloud.canEdit();
  }
  function ensureEdit() {
    if (canEdit()) return true;
    toast('У вас режим просмотра — изменения недоступны', 'warn');
    return false;
  }
  function roleLabel(role) {
    return role === 'owner' ? 'организатор' : role === 'editor' ? 'редактор' : role === 'viewer' ? 'только просмотр' : '';
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Скопировано', 'ok'); }, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Скопировано', 'ok'); }
      catch (e) { toast('Не удалось скопировать', 'err'); }
      ta.remove();
    }
  }

  function applyCloudData(data, meta) {
    if (state.mode !== 'real' || !data || !Array.isArray(data.people)) return;
    var res = validateData(data);
    if (res.errors.length) { console.warn('Облачные данные отклонены:', res.errors); return; }
    state.data = res.data;
    if (state.selection && !getPerson(state.selection)) state.selection = null;
    state.multi = new Set(Array.from(state.multi).filter(function (id) { return !!getPerson(id); }));
    state.collapsed = new Set(Array.from(state.collapsed).filter(function (id) { return !!getPerson(id); }));
    state.lineStart = null;
    if (view) view.clearPreview();
    saveJSON(dataKey(), state.data);
    recompute();
    renderBanner();
    renderWelcome();
    updateCloudUI();
    if (meta && meta.restored) toast('Версия восстановлена', 'ok');
    else if (meta && meta.merged) toast('Изменения объединены с правками ' + (meta.author || 'соавтора'), 'ok');
    else if (meta && meta.remote) toast('Обновлено: ' + (meta.author || 'соавтор'), 'ok');
  }

  function updateCloudUI() {
    var bar = $('cloudBar');
    var st = window.Cloud ? Cloud.getState() : { configured: false, active: false };
    var active = !!st.active;
    var readonly = active && !st.canEdit;
    document.body.classList.toggle('readonly', !!readonly);
    var addBtn = $('btnAdd');
    if (addBtn) addBtn.disabled = !!readonly;

    var cloudBtn = $('btnCloud');
    if (cloudBtn) {
      cloudBtn.classList.toggle('cloud-on', active);
      cloudBtn.classList.toggle('cloud-warn', !active && st.configured);
      cloudBtn.title = active
        ? 'Общее древо: ' + roleLabel(st.role) + ' · ' + st.statusText
        : st.configured ? 'Облако подключено · нет общего древа' : 'Соавторы и синхронизация';
    }
    updateHistoryUI();

    if (!bar) return;
    if (state.mode === 'demo' || !st.configured) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }

    var cls = st.status === 'saving' || st.status === 'connecting' ? 'saving'
      : st.status === 'offline' || st.status === 'error' ? 'offline' : 'online';
    var html = '<span class="dot"></span>';
    if (active) {
      html += '<span class="cb-text"><b>' + esc(st.treeName || 'Общее древо') + '</b>' +
        '<span class="cb-sep">·</span>' + esc(st.userName) + ' (' + esc(roleLabel(st.role)) + ')' +
        '<span class="cb-sep">·</span>' + esc(st.statusText) + '</span>' +
        (readonly ? '<span class="cb-badge">только просмотр</span>' : '') +
        '<span class="cb-spacer"></span>' +
        '<button class="linkbtn" data-cloud="history">История</button>' +
        '<button class="linkbtn" data-cloud="people">Соавторы · ' + st.members.length + '</button>';
    } else {
      html += '<span class="cb-text"><b>Облако подключено</b><span class="cb-sep">·</span>' + esc(st.userName) +
        '<span class="cb-sep">·</span>' + esc(st.statusText) + '</span>' +
        '<span class="cb-spacer"></span>' +
        '<button class="linkbtn" data-cloud="people">Создать или присоединиться</button>';
    }
    bar.className = 'cloudbar ' + cls;
    bar.hidden = false;
    bar.innerHTML = html;
  }

  function initCloud() {
    if (!window.Cloud) { updateCloudUI(); return; }
    Cloud.init({
      onData: applyCloudData,
      onStatus: updateCloudUI,
      onTree: updateCloudUI,
      onMembers: updateCloudUI
    }).then(function () { updateCloudUI(); }, function () { updateCloudUI(); });
    window.addEventListener('online', function () { Cloud.retry(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Cloud.isActive()) Cloud.retry();
    });
  }

  function openCloudSetup() {
    var cfg = (window.Cloud && Cloud.getConfig) ? Cloud.getConfig() : { url: '', anonKey: '' };
    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Совместная работа</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<p style="font-size:13.5px;margin-bottom:10px">Чтобы несколько человек могли редактировать одно древо с разных устройств, нужен бесплатный проект <b>Supabase</b>. Вход анонимный — почта и пароль не нужны.</p>' +
      '<div class="warn-box"><div><b>Подключение (один раз):</b>' +
      '<ol class="steps">' +
      '<li>Создайте проект на <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>.</li>' +
      '<li>SQL Editor → выполните <a href="./supabase/schema.sql" download>schema.sql</a>.</li>' +
      '<li>Authentication → Sign In / Providers → включите <b>Anonymous sign-ins</b>.</li>' +
      '<li>Project Settings → API → скопируйте <b>Project URL</b> и <b>anon public key</b>.</li>' +
      '</ol></div></div>' +
      '<label class="fld">Project URL<input class="field" id="cloudUrl" placeholder="https://xxxxx.supabase.co" value="' + esc(cfg.url || '') + '"></label>' +
      '<label class="fld">anon public key<textarea class="field" id="cloudKey" rows="3" placeholder="eyJhbGciOi…">' + esc(cfg.anonKey || '') + '</textarea></label>' +
      '<p class="help-text">Ключ anon публичный и не открывает доступ к чужим данным. Не вставляйте сюда service_role key.</p>' +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      (cfg.url ? '<button type="button" class="btn danger-ghost" id="cloudReset">Отключить облако</button>' : '') +
      '<button type="button" class="btn primary" id="cloudConnect">Подключить</button>' +
      '</div></div></div>';

    var close = showModal(html);
    var host = $('modalHost');

    host.querySelector('#cloudConnect').addEventListener('click', function () {
      var url = host.querySelector('#cloudUrl').value.trim();
      var key = host.querySelector('#cloudKey').value.trim();
      if (!/^https:\/\/.+/i.test(url)) { toast('Укажите Project URL вида https://…supabase.co', 'err'); return; }
      if (key.length < 40) { toast('Ключ выглядит слишком коротким', 'err'); return; }
      Cloud.saveConfig(url, key);
      close();
      toast('Подключено. Загружаю…', 'ok');
      setTimeout(function () { location.reload(); }, 700);
    });

    var reset = host.querySelector('#cloudReset');
    if (reset) reset.addEventListener('click', function () {
      confirmModal({
        title: 'Отключить облако?',
        html: '<p style="font-size:13.5px">Приложение вернётся к локальному режиму. Данные на сервере не удалятся, но общее древо перестанет открываться в этом браузере.</p>',
        confirmLabel: 'Отключить',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        Cloud.clearConfig();
        close();
        location.reload();
      });
    });
  }

  function openCloudJoinCreate() {
    var st = Cloud.getState();
    var defaultName = st.userName === 'Гость' ? '' : st.userName;
    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Общее древо</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<label class="fld">Ваше имя для соавторов<input class="field" id="ccName" maxlength="60" placeholder="Например: Анна" value="' + esc(defaultName) + '"></label>' +
      '<div class="d-sec" style="margin:16px 0 8px"><h4>Создать новое общее древо</h4></div>' +
      '<p class="help-text" style="margin:0 0 8px">Текущее древо из этого браузера станет общим. Его можно будет открыть с других устройств по коду.</p>' +
      '<div class="row-inline"><input class="field" id="ccTreeName" maxlength="80" placeholder="Название древа" value="Семейное древо"><button class="btn primary" id="ccCreate">Создать</button></div>' +
      '<div class="d-sec" style="margin:18px 0 8px"><h4>Присоединиться по коду</h4></div>' +
      '<p class="help-text" style="margin:0 0 8px">Код приглашения выдаёт тот, кто создал древо (кнопка ☁ → «Соавторы»). <b>Текущее древо в этом браузере будет заменено общим.</b></p>' +
      '<div class="row-inline"><input class="field" id="ccCode" maxlength="12" placeholder="Например: A1B2C3D4" style="text-transform:uppercase"><button class="btn" id="ccJoin">Войти</button></div>' +
      '<p class="help-text" style="margin-top:14px"><button type="button" class="linkbtn" id="ccSetup">Настройки подключения</button></p>' +
      '</div></div>';
    var close = showModal(html);
    var host = $('modalHost');

    host.querySelector('#ccSetup').addEventListener('click', function () { close(); openCloudSetup(); });

    function nameVal() {
      var n = host.querySelector('#ccName').value.trim();
      if (n) Cloud.setProfileName(n);
      return n;
    }

    host.querySelector('#ccCreate').addEventListener('click', function () {
      var btn = this;
      var nm = nameVal();
      if (!nm) { toast('Введите имя', 'err'); return; }
      var title = host.querySelector('#ccTreeName').value.trim() || 'Семейное древо';
      btn.disabled = true;
      Cloud.createTree(title, state.data).then(function () {
        close();
        updateCloudUI();
        toast('Общее древо создано', 'ok');
        if (view) view.fit(true);
      }, function (e) {
        btn.disabled = false;
        toast('Не удалось создать: ' + (e.message || e), 'err');
      });
    });

    host.querySelector('#ccJoin').addEventListener('click', function () {
      var btn = this;
      var nm = nameVal();
      if (!nm) { toast('Введите имя', 'err'); return; }
      var code = host.querySelector('#ccCode').value.trim();
      if (!code) { toast('Введите код приглашения', 'err'); return; }
      btn.disabled = true;
      Cloud.joinTree(code).then(function () {
        close();
        updateCloudUI();
        toast('Вы присоединились к древу', 'ok');
        setTimeout(function () { if (view) view.fit(true); }, 100);
      }, function (e) {
        btn.disabled = false;
        toast(e.message || 'Не удалось присоединиться', 'err');
      });
    });
  }

  function openCollaborators() {
    if (!window.Cloud || !Cloud.isConfigured()) { openCloudSetup(); return; }
    if (!Cloud.getState().active) { openCloudJoinCreate(); return; }

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Соавторы и доступ</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body" id="collabContent"></div>' +
      '</div>';
    var close = showModal(html);
    function refresh() { fillCollab(close); }
    refresh();
    Cloud.refreshMembers().then(refresh, refresh);
  }

  function fillCollab(close) {
    var host = $('modalHost');
    var box = host.querySelector('#collabContent');
    if (!box) return;
    var st = Cloud.getState();
    if (!st.active) { box.innerHTML = '<p class="help-text">Общее древо отключено.</p>'; return; }

    var isOwner = st.role === 'owner';
    var rows = st.members.map(function (m) {
      var name = esc(m.display_name || 'Без имени') + (m.is_self ? ' <span class="cb-badge">вы</span>' : '');
      var roleHtml;
      if (isOwner && !m.is_self && m.role !== 'owner') {
        roleHtml = '<select class="field mini" data-role-for="' + esc(m.user_id) + '" title="Роль участника">' +
          '<option value="editor"' + (m.role === 'editor' ? ' selected' : '') + '>редактор</option>' +
          '<option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>просмотр</option>' +
          '</select>';
      } else {
        roleHtml = '<span class="role-tag ' + esc(m.role) + '">' + esc(roleLabel(m.role)) + '</span>';
      }
      var del = (isOwner && !m.is_self && m.role !== 'owner')
        ? '<button class="icon-btn danger-text" data-remove-member="' + esc(m.user_id) + '" title="Убрать участника" aria-label="Убрать">&#215;</button>'
        : '';
      return '<div class="member-row">' +
        '<div class="member-ava">' + esc((m.display_name || '?').slice(0, 1).toUpperCase()) + '</div>' +
        '<div class="member-main"><div class="member-name">' + name + '</div>' +
        '<div class="member-sub">' + (m.joined_at ? 'с ' + esc(fmtDateTime(m.joined_at)) : '') + '</div></div>' +
        roleHtml + del + '</div>';
    }).join('') || '<p class="help-text">Пока только вы.</p>';

    box.innerHTML =
      '<div class="invite-box">' +
      '<div><div class="invite-label">Код приглашения</div><div class="invite-row">' +
      '<span class="invite-code" id="inviteCode">' + esc(st.invite || '—') + '</span>' +
      '<button class="btn" id="copyInvite">Скопировать</button></div></div>' +
      (isOwner ? '<button class="linkbtn" id="rotateInvite">Новый код</button>' : '') +
      '</div>' +
      '<p class="help-text">Передайте код тому, кого хотите добавить: он откроет приложение, нажмёт ☁ и введёт код. Новые участники по умолчанию могут редактировать — роль можно сменить ниже.</p>' +
      '<div class="d-sec" style="margin:16px 0 4px"><h4>Участники · ' + st.members.length + '</h4></div>' +
      '<div class="member-list">' + rows + '</div>' +
      '<div class="d-sec" style="margin:18px 0 6px"><h4>Ваше имя</h4></div>' +
      '<div class="row-inline"><input class="field" id="collabMyName" maxlength="60" value="' + esc(st.userName) + '">' +
      '<button class="btn" id="saveMyName">Сохранить</button></div>' +
      (isOwner
        ? '<div class="d-sec" style="margin:18px 0 6px"><h4>Название древа</h4></div>' +
          '<div class="row-inline"><input class="field" id="collabTreeName" maxlength="80" value="' + esc(st.treeName || '') + '">' +
          '<button class="btn" id="saveTreeName">Переименовать</button></div>'
        : '') +
      '<div class="modal-actions" style="padding:18px 0 0;border:0">' +
      '<span style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-right:auto">' +
      '<button type="button" class="linkbtn" id="collabSetup">Настройки подключения</button>' +
      (isOwner ? '<span class="help-text">Организатор не может выйти — передайте роль вручную.</span>'
        : '<button type="button" class="btn danger-ghost" id="leaveTree">Покинуть древо</button>') +
      '</span>' +
      '<button type="button" class="btn primary" id="collabDone">Готово</button>' +
      '</div>';

    function act(fn, okText) {
      fn().then(function () { toast(okText, 'ok'); }, function (e) { toast(e.message || 'Ошибка', 'err'); });
    }

    var copyBtn = box.querySelector('#copyInvite');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyText(st.invite || ''); });

    var rotate = box.querySelector('#rotateInvite');
    if (rotate) rotate.addEventListener('click', function () {
      confirmModal({
        title: 'Создать новый код?',
        html: '<p style="font-size:13.5px">Старый код перестанет работать. Все, кто уже присоединился, останутся в древе.</p>',
        confirmLabel: 'Новый код'
      }).then(function (yes) {
        if (!yes) return;
        act(function () { return Cloud.rotateInvite(); }, 'Код обновлён');
        setTimeout(function () { fillCollab(close); }, 300);
      });
    });

    box.querySelectorAll('[data-role-for]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var uid = sel.getAttribute('data-role-for');
        act(function () { return Cloud.setRole(uid, sel.value); }, 'Роль изменена');
        setTimeout(function () { fillCollab(close); }, 300);
      });
    });

    box.querySelectorAll('[data-remove-member]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-remove-member');
        confirmModal({
          title: 'Убрать участника?',
          html: '<p style="font-size:13.5px">Участник потеряет доступ к этому древу. Его правки в истории останутся.</p>',
          confirmLabel: 'Убрать',
          danger: true
        }).then(function (yes) {
          if (!yes) return;
          act(function () { return Cloud.removeMember(uid); }, 'Участник убран');
          setTimeout(function () { fillCollab(close); }, 300);
        });
      });
    });

    box.querySelector('#saveMyName').addEventListener('click', function () {
      var n = box.querySelector('#collabMyName').value.trim();
      if (!n) { toast('Введите имя', 'err'); return; }
      Cloud.setProfileName(n);
      act(function () { return Cloud.setMyName(n); }, 'Имя сохранено');
      setTimeout(function () { fillCollab(close); }, 300);
    });

    var saveTree = box.querySelector('#saveTreeName');
    if (saveTree) saveTree.addEventListener('click', function () {
      var n = box.querySelector('#collabTreeName').value.trim();
      act(function () { return Cloud.renameTree(n); }, 'Название сохранено');
      setTimeout(function () { fillCollab(close); }, 300);
    });

    var leave = box.querySelector('#leaveTree');
    if (leave) leave.addEventListener('click', function () {
      confirmModal({
        title: 'Покинуть общее древо?',
        html: '<p style="font-size:13.5px">Доступ к общему древу закроется. Локальная копия данных останется в браузере. Вернуться можно по новому коду приглашения.</p>',
        confirmLabel: 'Покинуть',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        Cloud.leaveTree().then(function () {
          close();
          updateCloudUI();
          toast('Вы покинули древо', 'ok');
        }, function (e) { toast(e.message || 'Ошибка', 'err'); });
      });
    });

    box.querySelector('#collabDone').addEventListener('click', close);
    box.querySelector('#collabSetup').addEventListener('click', function () { close(); openCloudSetup(); });
  }

  function openHistory() {
    if (!window.Cloud || !Cloud.isConfigured()) { openCloudSetup(); return; }
    if (!Cloud.getState().active) { openCloudJoinCreate(); return; }

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>История изменений</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<p class="help-text" style="margin:0 0 12px">Сохраняются последние 30 дней (до 300 записей). Перемещение карточек по холсту в историю не попадает — только изменения людей и связей.</p>' +
      '<div class="hist-list" id="histList"><div class="hist-empty">Загрузка…</div></div>' +
      '</div></div>';
    var close = showModal(html);
    var host = $('modalHost');

    Cloud.listVersions().then(function (list) {
      var box = host.querySelector('#histList');
      if (!box) return;
      if (!list.length) { box.innerHTML = '<div class="hist-empty">Пока нет сохранённых версий.</div>'; return; }
      var can = Cloud.canEdit();
      box.innerHTML = list.map(function (v) {
        var people = v.people_count || 0;
        var rels = v.relations_count || 0;
        return '<div class="hist-row">' +
          '<div class="hist-main">' +
          '<div class="hist-time">' + esc(fmtDateTime(v.created_at)) + '</div>' +
          '<div class="hist-sub">' + esc(v.author_name || 'Соавтор') + ' · ' + people + ' ' + plural(people, 'человек', 'человека', 'человек') +
          ' · ' + rels + ' ' + plural(rels, 'связь', 'связи', 'связей') + '</div>' +
          '</div>' +
          (can ? '<button class="btn" data-restore="' + esc(v.id) + '">Вернуть</button>' : '') +
          '</div>';
      }).join('');

      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-restore]');
        if (!b) return;
        var id = b.getAttribute('data-restore');
        confirmModal({
          title: 'Восстановить версию?',
          html: '<p style="font-size:13.5px">Текущее состояние станет новой записью истории, а древо вернётся к выбранному моменту. Соавторы увидят это сразу.</p>',
          confirmLabel: 'Восстановить'
        }).then(function (yes) {
          if (!yes) return;
          Cloud.restoreVersion(id).then(function () {
            close();
            updateCloudUI();
            if (view) view.fit(true);
            toast('Версия восстановлена', 'ok');
          }, function (err) {
            toast(err.message || 'Не удалось восстановить', 'err');
          });
        });
      });
    }).catch(function (e) {
      var box = host.querySelector('#histList');
      if (box) box.innerHTML = '<div class="hist-empty">Не удалось загрузить историю: ' + esc(e.message || e) + '</div>';
    });
  }

  // ==================== ЭКСПОРТ / ИМПОРТ ====================
  function exportJSON() {
    var payload = {
      app: 'family-tree',
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      people: state.data.people,
      relations: state.data.relations,
      positions: state.data.positions || {},
      freeLines: state.data.freeLines || [],
      appearance: state.data.appearance || { relations: {} }
    };
    var date = new Date().toISOString().slice(0, 10);
    var name = (state.mode === 'demo' ? 'семейное-древо-пример-' : 'семейное-древо-') + date + '.json';
    download(name, JSON.stringify(payload, null, 2));
    state.ui.lastExport = Date.now();
    saveUI();
    renderBanner();
    toast('Резервная копия сохранена', 'ok');
  }

  function handleImportFile(file) {
    if (!ensureEdit()) return;
    var reader = new FileReader();
    reader.onerror = function () { toast('Не удалось прочитать файл', 'err'); };
    reader.onload = function () {
      var obj;
      try { obj = JSON.parse(reader.result); }
      catch (e) {
        confirmModal({
          title: 'Импорт не выполнен',
          html: '<div class="warn-box danger">Файл не является корректным JSON.</div>',
          confirmLabel: 'Понятно'
        });
        return;
      }
      var res = validateData(obj);
      if (res.errors.length) {
        var list = res.errors.slice(0, 12).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('');
        confirmModal({
          title: 'Импорт не выполнен',
          html: '<div class="warn-box danger">Проверка структуры и связей не пройдена. Данные не изменены.</div>' +
            '<ul class="err-list">' + list + '</ul>' +
            (res.errors.length > 12 ? '<p class="help-text">…и ещё ' + (res.errors.length - 12) + '</p>' : ''),
          confirmLabel: 'Понятно'
        });
        return;
      }

      var nPeople = res.data.people.length;
      var nRel = res.data.relations.length;
      confirmModal({
        title: 'Импортировать резервную копию?',
        html: '<div class="warn-box"><b>Внимание:</b> текущее древо будет полностью заменено на импортируемое (' +
          nPeople + ' ' + plural(nPeople, 'человек', 'человека', 'человек') + ', ' + nRel + ' ' + plural(nRel, 'связь', 'связи', 'связей') + ').</div>' +
          '<p class="help-text">Рекомендуем сначала скачать копию текущего древа.</p>',
        extra: '<button class="btn ghost" id="impBackup">Скачать копию текущего</button>',
        confirmLabel: 'Импортировать',
        onMount: function (host) {
          host.querySelector('#impBackup').addEventListener('click', function () { exportJSON(); });
        }
      }).then(function (yes) {
        if (!yes) return;
        pushHistory();
        state.data = res.data;
        state.collapsed.clear();
        saveCollapsed();
        state.selection = null;
        state.multi = new Set();
        state.lineStart = null;
        view.clearPreview();
        saveNow();
        recompute();
        view.fit(true);
        renderBanner();
        toast('Импортировано: ' + nPeople + ' человек', 'ok');
      });
    };
    reader.readAsText(file);
  }

  // ==================== ИЗОБРАЖЕНИЕ И ПЕЧАТЬ ====================
  async function buildPNGBlob() {
    if (!state.data.people.length) return null;
    var byId = new Map(state.data.people.map(function (p) { return [p.id, p]; }));
    return FT.exportPNG(state.layout, byId, { scale: 2 });
  }

  async function exportTreePNG() {
    var blob = await buildPNGBlob();
    if (!blob) { toast('Древо пустое', 'warn'); return; }
    download('семейное-древо.png', blob);
    toast('Изображение сохранено', 'ok');
  }

  async function printTree() {
    var blob = await buildPNGBlob();
    if (!blob) { toast('Древо пустое', 'warn'); return; }
    var url = URL.createObjectURL(blob);
    var win = window.open('', '_blank');
    if (!win) { window.location.href = url; return; }
    win.document.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Семейное древо</title>' +
      '<style>body{margin:0;padding:12px;font-family:system-ui,sans-serif}img{max-width:100%}@media print{@page{size:auto;margin:10mm}}</style>' +
      '</head><body><img src="' + url + '" alt="Семейное древо" onload="window.focus();window.print()"></body></html>');
    win.document.close();
  }

  // ==================== ОЧИСТКА ====================
  function clearTree() {
    if (!ensureEdit()) return;
    if (!state.data.people.length) { toast('Древо и так пустое', 'warn'); return; }
    confirmModal({
      title: 'Очистить древо?',
      html: '<div class="warn-box danger"><b>Это действие необратимо.</b> Все ' + state.data.people.length +
        ' ' + plural(state.data.people.length, 'запись', 'записи', 'записей') + ' и связи будут удалены.</div>' +
        '<p class="help-text">Рекомендуем сначала скачать резервную копию JSON.</p>' +
        '<label class="fld">Введите слово <b>удалить</b> для подтверждения' +
        '<input class="field" id="clearConfirm" placeholder="удалить" autocomplete="off"></label>',
      extra: '<button class="btn ghost" id="clearBackup">Скачать копию</button>',
      confirmLabel: 'Очистить',
      danger: true,
      onMount: function (host) {
        var inp = host.querySelector('#clearConfirm');
        var ok = host.querySelector('[data-ok]');
        ok.disabled = true;
        inp.addEventListener('input', function () { ok.disabled = inp.value.trim().toLowerCase() !== 'удалить'; });
        host.querySelector('#clearBackup').addEventListener('click', function () { exportJSON(); });
      }
    }).then(function (yes) {
      if (!yes) return;
      pushHistory();
      state.data = blankData();
      state.collapsed.clear();
      saveCollapsed();
      state.selection = null;
      state.multi = new Set();
      state.filterGens = null;
      saveNow();
      recompute();
      view.setFilter(null);
      toast('Древо очищено', 'ok');
    });
  }

  function openAbout() {
    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>О программе и приватности</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<p style="font-size:13.5px;margin-bottom:12px">«Семейное древо» — конструктор родословной. Добавляйте людей, связывайте их отношениями и смотрите интерактивную схему семьи.</p>' +
      '<div class="warn-box"><div>🔒 <b>Приватность.</b> Без общего древа все имена, даты, фотографии и связи хранятся <b>только в этом браузере</b> (localStorage). Если вы подключили совместную работу, данные сохраняются ещё и в <b>вашем собственном проекте Supabase</b>. Сторонней аналитики, собирающей содержимое древа, здесь нет.</div></div>' +
      '<div class="warn-box"><div>&#9888; <b>Резервная копия.</b> Браузер может удалить данные при очистке истории или переустановке. Регулярно сохраняйте копию в JSON (меню → Экспорт).</div></div>' +
      '<div class="d-sec"><h4>Как связаны люди</h4><div class="legend">' +
      '<span class="lg"><span class="bar"></span>родитель — ребёнок</span>' +
      '<span class="lg"><span class="bar adoptive"></span>приёмный родитель</span>' +
      '<span class="lg"><span class="bar spouse"></span>супруги</span>' +
      '<span class="lg"><span class="swatch g0"></span>цвет = поколение</span>' +
      '</div></div>' +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      '<button type="button" class="btn" id="aboutExport">Скачать копию</button>' +
      '<button type="button" class="btn primary" data-close>Закрыть</button>' +
      '</div></div></div>';
    var close = showModal(html);
    $('modalHost').querySelector('#aboutExport').addEventListener('click', function () { exportJSON(); });
    void close;
  }

  // ==================== ПРИВЕТСТВИЕ / ПУСТОЕ ====================
  function renderWelcome() {
    var show = state.mode === 'real' && !state.ui.seenWelcome && !state.data.people.length;
    var host = $('welcomeHost');
    if (!show) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="welcome"><div class="welcome-card">' +
      '<svg class="wlogo" viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="18" cy="18" r="8" fill="none" stroke="var(--acc)" stroke-width="4"/>' +
      '<circle cx="46" cy="18" r="8" fill="none" stroke="var(--acc)" stroke-width="4"/>' +
      '<circle cx="32" cy="48" r="8" fill="none" stroke="var(--acc)" stroke-width="4"/>' +
      '<path d="M18 26v7a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4v-7M32 41v-4" fill="none" stroke="var(--acc)" stroke-width="3.6" stroke-linecap="round"/>' +
      '</svg>' +
      '<h1>Семейное древо</h1>' +
      '<p>Соберите историю своей семьи по одному человеку за раз. Начните с себя или с любого родственника, о котором что-то знаете.</p>' +
      '<div class="welcome-form">' +
      '<div class="row2">' +
      '<label class="fld">Имя<input class="field" id="wName" placeholder="Иван"></label>' +
      '<label class="fld">Фамилия<input class="field" id="wSurname" placeholder="Иванов"></label>' +
      '</div></div>' +
      '<div class="welcome-actions">' +
      '<button class="btn primary" id="wStart">Создать своё древо</button>' +
      '<button class="btn" id="wDemo">Посмотреть пример</button>' +
      '<button class="linkbtn" id="wSkip" style="align-self:center">Пропустить</button>' +
      '</div>' +
      '<div class="privacy-note">Данные хранятся в вашем браузере. Совместную работу можно подключить отдельно — в меню ☁.</div>' +
      '</div></div>';

    $('wStart').addEventListener('click', function () {
      if (!ensureEdit()) return;
      var name = $('wName').value.trim();
      var surname = $('wSurname').value.trim();
      if (!name && !surname) { toast('Введите имя или фамилию', 'err'); return; }
      state.ui.seenWelcome = true;
      saveUI();
      var p = addPerson({ name: name, surname: surname });
      saveNow();
      host.innerHTML = '';
      recompute();
      selectPerson(p.id, { scrollList: true });
      view.fit(true);
      toast('Это вы? Нажмите на карточку и добавьте родственников', 'ok');
    });
    $('wDemo').addEventListener('click', function () {
      state.ui.seenWelcome = true;
      saveUI();
      enterDemo();
      host.innerHTML = '';
    });
    $('wSkip').addEventListener('click', function () {
      state.ui.seenWelcome = true;
      saveUI();
      host.innerHTML = '';
      updateEmpty();
    });
  }

  // ==================== ПЛАШКА ====================
  function renderBanner() {
    var b = $('banner');
    if (state.mode === 'demo') {
      b.className = 'banner demo';
      b.hidden = false;
      b.innerHTML = '<div>Режим примера: изменения сохраняются отдельно и не затрагивают ваше древо.</div>' +
        '<div class="b-actions"><button class="btn ghost" id="bExit">Выйти из примера</button></div>';
      $('bExit').addEventListener('click', exitDemo);
      return;
    }
    var due = state.data.people.length >= 3 &&
      (Date.now() - state.ui.lastExport > WEEK) &&
      (Date.now() - state.ui.lastRemind > 3 * 24 * 60 * 60 * 1000);
    if (!due) { b.hidden = true; b.innerHTML = ''; return; }
    var when = state.ui.lastExport ? Math.round((Date.now() - state.ui.lastExport) / (24 * 60 * 60 * 1000)) + ' дн. назад' : 'никогда';
    b.className = 'banner';
    b.hidden = false;
    b.innerHTML = '<div>Данные хранятся только в этом браузере. Последняя резервная копия: ' + esc(when) + '.</div>' +
      '<div class="b-actions"><button class="btn ghost" id="bExport">Скачать копию</button>' +
      '<button class="b-close" id="bClose" title="Позже" aria-label="Скрыть">&#215;</button></div>';
    $('bExport').addEventListener('click', exportJSON);
    $('bClose').addEventListener('click', function () {
      state.ui.lastRemind = Date.now();
      saveUI();
      b.hidden = true;
    });
  }

  // ==================== РЕЖИМЫ ====================
  function enterDemo() {
    state.mode = 'demo';
    state.ui.mode = 'demo';
    saveUI();
    resetTransient();
    loadData();
    loadCollapsed();
    recompute();
    view.setFilter(null);
    view.fit(true);
    renderBanner();
    toast('Включён режим примера', 'ok');
  }
  function exitDemo() {
    state.mode = 'real';
    state.ui.mode = 'real';
    saveUI();
    resetTransient();
    loadData();
    loadCollapsed();
    recompute();
    view.setFilter(null);
    view.fit(true);
    renderBanner();
    renderWelcome();
    toast('Вы вернулись к своему древу', 'ok');
  }

  // ==================== ДЕМО-ДАННЫЕ ====================
  function demoData() {
    var P = function (id, name, surname, o) {
      return Object.assign({ id: id, name: name, surname: surname, maiden: '', gender: '', birthDate: '', birthPlace: '', deathDate: '', deathPlace: '', profession: '', bio: '', photo: '', createdAt: Date.now() }, o || {});
    };
    var people = [
      P('d1', 'Иван', 'Иванов', { gender: 'm', birthDate: '1901', birthPlace: 'г. Тверь', deathDate: '1977', profession: 'Кузнец', bio: 'Основатель семьи. Работал в кузнице, мастер на все руки.' }),
      P('d2', 'Мария', 'Иванова', { maiden: 'Соколова', gender: 'f', birthDate: '1905', birthPlace: 'г. Тверь', deathDate: '1982', profession: 'Учительница начальных классов' }),
      P('d3', 'Николай', 'Иванов', { gender: 'm', birthDate: '1930', birthPlace: 'г. Тверь', deathDate: '2001', profession: 'Инженер-строитель', bio: 'Строил мосты и жилые дома.' }),
      P('d4', 'Галина', 'Иванова', { maiden: 'Кузнецова', gender: 'f', birthDate: '1935', deathDate: '2010', profession: 'Врач' }),
      P('d5', 'Вера', 'Иванова', { gender: 'f', birthDate: '1938', profession: 'Библиотекарь' }),
      P('d6', 'Пётр', 'Смирнов', { gender: 'm', birthDate: '1936', deathDate: '2008', profession: 'Военный лётчик' }),
      P('d7', 'Сергей', 'Иванов', { gender: 'm', birthDate: '1958', birthPlace: 'г. Санкт-Петербург', profession: 'Программист', bio: 'Один из первых программистов в семье.' }),
      P('d8', 'Елена', 'Иванова', { maiden: 'Морозова', gender: 'f', birthDate: '1962', profession: 'Дизайнер' }),
      P('d9', 'Ольга', 'Иванова', { gender: 'f', birthDate: '1965', profession: 'Переводчица' }),
      P('d10', 'Андрей', 'Лебедев', { gender: 'm', birthDate: '1963', profession: 'Фотограф' }),
      P('d11', 'Дмитрий', 'Иванов', { gender: 'm', birthDate: '1985', profession: 'Архитектор' }),
      P('d12', 'Артём', 'Лебедев', { gender: 'm', birthDate: '1992', profession: 'Музыкант' }),
      P('d13', 'Ксения', 'Иванова', { gender: 'f', birthDate: '1990', profession: 'Врач-кардиолог' }),
      P('d14', 'Анна', 'Иванова', { maiden: 'Петрова', gender: 'f', birthDate: '1988', profession: 'Врач-педиатр' }),
      P('d15', 'Максим', 'Иванов', { gender: 'm', birthDate: '2012', bio: 'Любит собирать модели самолётов.' }),
      P('d16', 'Павел', 'Иванов', { gender: 'm', birthDate: '1998', profession: 'Учитель истории', bio: 'Приёмный сын в семье Сергея и Елены.' }),
      P('d17', 'София', 'Иванова', { gender: 'f', birthDate: '2016' }),
      P('d20', 'Игорь', 'Смирнов', { gender: 'm', birthDate: '1962', profession: 'Военный инженер' })
    ];
    var R = function (a, b, sub) { return { id: uid('r'), type: 'parent', subtype: sub || 'bio', a: a, b: b }; };
    var S = function (a, b, sub) { return { id: uid('r'), type: 'spouse', subtype: sub || 'married', a: a, b: b }; };
    var relations = [
      S('d1', 'd2'), S('d3', 'd4'), S('d5', 'd6'), S('d7', 'd8'), S('d11', 'd14'), S('d9', 'd10', 'partner'),
      R('d1', 'd3'), R('d2', 'd3'), R('d1', 'd5'), R('d2', 'd5'),
      R('d3', 'd7'), R('d4', 'd7'), R('d3', 'd9'), R('d4', 'd9'),
      R('d5', 'd20'), R('d6', 'd20'),
      R('d7', 'd11'), R('d8', 'd11'), R('d7', 'd13'), R('d8', 'd13'),
      R('d7', 'd16', 'adoptive'), R('d8', 'd16', 'adoptive'),
      R('d9', 'd12'),
      R('d10', 'd12', 'step'),
      R('d11', 'd15'), R('d14', 'd15'), R('d11', 'd17'), R('d14', 'd17')
    ];
    return {
      version: DATA_VERSION,
      people: people,
      relations: relations,
      positions: {},
      freeLines: [],
      appearance: { relations: {} }
    };
  }

  // ==================== КОНСТРУКТОР: СВЯЗИ ====================
  var REL_TYPE_META = {
    parent: { name: 'Родитель — ребёнок', opts: [{ sub: 'bio', label: 'Родной родитель' }, { sub: 'adoptive', label: 'Приёмный родитель' }, { sub: 'step', label: 'Отчим / мачеха' }] },
    spouse: { name: 'Супруги / партнёры', opts: [{ sub: 'married', label: 'Супруги' }, { sub: 'partner', label: 'Партнёры' }] },
    sibling: { name: 'Братья / сёстры', opts: [{ sub: 'bio', label: 'Родные' }, { sub: 'half', label: 'Сводные / неполнородные' }] },
    unknown: { name: 'Неизвестная связь', opts: [{ sub: 'unconfirmed', label: 'Не подтверждено' }] }
  };
  var LINE_COLORS = [
    { v: '', label: 'По умолчанию' },
    { v: '#2e8b64', label: 'Зелёный' },
    { v: '#5b7fd4', label: 'Синий' },
    { v: '#c08b3c', label: 'Оранжевый' },
    { v: '#c56982', label: 'Розовый' },
    { v: '#c0392b', label: 'Красный' },
    { v: '#5f7168', label: 'Серый' }
  ];
  var LINE_DASHES = [
    { v: '', label: 'Сплошная', a: [] },
    { v: 'dash', label: 'Пунктир', a: [7, 5] },
    { v: 'dot', label: 'Точки', a: [2, 5] },
    { v: 'dashdot', label: 'Штрих-пунктир', a: [8, 4, 2, 4] }
  ];
  var CONNECT_OPTIONS = [
    { group: 'Родитель — ребёнок', label: 'Первый — родитель второго', type: 'parent', sub: 'bio', dir: 'meParent' },
    { group: 'Родитель — ребёнок', label: 'Первый — ребёнок второго', type: 'parent', sub: 'bio', dir: 'meChild' },
    { group: 'Усыновление', label: 'Первый — приёмный родитель', type: 'parent', sub: 'adoptive', dir: 'meParent' },
    { group: 'Усыновление', label: 'Первый — приёмный ребёнок', type: 'parent', sub: 'adoptive', dir: 'meChild' },
    { group: 'Отчим / мачеха', label: 'Первый — отчим или мачеха', type: 'parent', sub: 'step', dir: 'meParent' },
    { group: 'Отчим / мачеха', label: 'Первый — пасынок или падчерица', type: 'parent', sub: 'step', dir: 'meChild' },
    { group: 'Супруги и партнёры', label: 'Супруги', type: 'spouse', sub: 'married', dir: 'sym' },
    { group: 'Супруги и партнёры', label: 'Партнёры', type: 'spouse', sub: 'partner', dir: 'sym' },
    { group: 'Братья и сёстры', label: 'Братья или сёстры', type: 'sibling', sub: 'bio', dir: 'sym' },
    { group: 'Братья и сёстры', label: 'Сводные братья или сёстры', type: 'sibling', sub: 'half', dir: 'sym' },
    { group: 'Прочее', label: 'Неизвестная или неподтверждённая связь', type: 'unknown', sub: 'unconfirmed', dir: 'sym' }
  ];

  function applyConnect(person, otherId, opt) {
    if (!ensureEdit()) return false;
    if (!otherId || otherId === person.id) { toast('Выберите второго человека из списка', 'err'); return false; }
    var a = person.id, b = otherId;
    var g;
    if (opt.dir === 'meParent') {
      if (opt.sub !== 'step') { g = guardParentLink(a, b); if (!g.ok) { toast(g.msg, 'err'); return false; } }
    } else if (opt.dir === 'meChild') {
      if (opt.sub !== 'step') { g = guardParentLink(b, a); if (!g.ok) { toast(g.msg, 'err'); return false; } }
    }
    pushHistory();
    var r;
    if (opt.dir === 'sym') r = addRelation(opt.type, opt.sub, a, b);
    else if (opt.dir === 'meParent') r = addRelation('parent', opt.sub, a, b);
    else r = addRelation('parent', opt.sub, b, a);
    if (!r) {
      state.history.pop();
      updateHistoryUI();
      toast('Такая связь уже существует', 'warn');
      return false;
    }
    saveNow();
    recompute();
    renderBanner();
    toast('Связь создана', 'ok');
    return true;
  }

  function openConnectModal(person, opts) {
    if (!ensureEdit()) return;
    opts = opts || {};
    if (!person) return;
    var other = opts.other ? getPerson(opts.other) : null;

    var groups = [];
    CONNECT_OPTIONS.forEach(function (o, i) {
      o._i = i;
      var g = null;
      groups.forEach(function (x) { if (x.name === o.group) g = x; });
      if (!g) { g = { name: o.group, opts: [] }; groups.push(g); }
      g.opts.push(o);
    });
    var typeHtml = groups.map(function (g) {
      return '<optgroup label="' + esc(g.name) + '">' +
        g.opts.map(function (o) { return '<option value="' + o._i + '">' + esc(o.label) + '</option>'; }).join('') +
        '</optgroup>';
    }).join('');

    var whoLine = other
      ? '<p class="help-text" style="margin:-6px 0 10px">Связываем <b>' + esc(FT.personName(person)) + '</b> и <b>' + esc(FT.personName(other)) + '</b>. «Первый» — это ' + esc(FT.personName(person)) + '.</p>'
      : '<p class="help-text" style="margin:-6px 0 10px">«Первый» — это <b>' + esc(FT.personName(person)) + '</b>. Родство задаётся вручную и не выводится автоматически.</p>';

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>' + esc(opts.title || ('Создать связь — ' + FT.personName(person))) + '</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<label class="fld">Тип связи<select class="field" id="cnType">' + typeHtml + '</select></label>' +
      whoLine +
      (other ? '' :
        '<label class="fld">С кем связать?<input class="field" id="cnSearch" placeholder="Поиск по имени…" autocomplete="off"></label>' +
        '<div class="pick-list" id="cnList"></div>') +
      '<div class="modal-actions" style="padding:14px 0 0;border:0">' +
      '<button type="button" class="btn" data-close>Отмена</button>' +
      '<button type="button" class="btn primary" id="cnDo">Создать связь</button>' +
      '</div></div></div>';

    var close = showModal(html);
    var host = $('modalHost');
    var selected = other ? other.id : null;

    function renderCandidates() {
      if (other) return;
      var q = (host.querySelector('#cnSearch').value || '').trim().toLowerCase();
      var h = '';
      state.data.people.forEach(function (p) {
        if (p.id === person.id) return;
        if (q && FT.personName(p).toLowerCase().indexOf(q) < 0 && (p.maiden || '').toLowerCase().indexOf(q) < 0) return;
        var gen = state.genMap.get(p.id);
        h += '<button type="button" class="pick-item ' + (gen == null ? '' : gclass(gen)) + (selected === p.id ? ' on' : '') + '" data-pick="' + esc(p.id) + '">' +
          FT.avatarHtml(p, 'pava') +
          '<div><div class="pname">' + esc(FT.personName(p)) + '</div><div class="pmeta">' + esc(personMeta(p)) + '</div></div>' +
          '</button>';
      });
      host.querySelector('#cnList').innerHTML = h || '<div style="padding:12px;color:var(--dim);font-size:13px">Нет подходящих людей</div>';
    }

    if (!other) {
      host.querySelector('#cnSearch').addEventListener('input', renderCandidates);
      host.querySelector('#cnList').addEventListener('click', function (e) {
        var b = e.target.closest('[data-pick]');
        if (!b) return;
        selected = b.getAttribute('data-pick');
        Array.prototype.forEach.call(host.querySelectorAll('[data-pick]'), function (x) { x.classList.toggle('on', x === b); });
      });
      renderCandidates();
    }

    host.querySelector('#cnDo').addEventListener('click', function () {
      if (!selected) { toast('Выберите человека из списка', 'err'); return; }
      var opt = CONNECT_OPTIONS[parseInt(host.querySelector('#cnType').value, 10)];
      if (applyConnect(person, selected, opt)) close();
    });
  }

  function startConnectFromSelection() {
    if (!state.selection) { toast('Сначала выберите человека', 'warn'); return; }
    openConnectModal(getPerson(state.selection), {});
  }

  // ==================== КОНСТРУКТОР: РЕДАКТОР СВЯЗИ ====================
  function styleFieldsHtml(st) {
    var colorOpts = LINE_COLORS.map(function (c) {
      return '<option value="' + c.v + '"' + ((st.color || '') === c.v ? ' selected' : '') + '>' + esc(c.label) + '</option>';
    }).join('');
    var dashVal = '';
    if (st.dash && st.dash.length) {
      LINE_DASHES.forEach(function (d) { if (d.a.length && d.a.join(',') === st.dash.join(',')) dashVal = d.v; });
    }
    var dashOpts = LINE_DASHES.map(function (d) {
      return '<option value="' + d.v + '"' + (dashVal === d.v ? ' selected' : '') + '>' + esc(d.label) + '</option>';
    }).join('');
    var width = st.width != null ? st.width : 2;
    return '<div class="form-grid" style="margin-top:4px">' +
      '<label class="fld">Цвет линии<select class="field" id="styleColor">' + colorOpts + '</select></label>' +
      '<label class="fld">Стиль линии<select class="field" id="styleDash">' + dashOpts + '</select></label>' +
      '<label class="fld">Толщина: <span id="styleWidthVal">' + width + '</span><input type="range" min="1" max="8" step="0.5" value="' + width + '" id="styleWidth" style="width:100%"></label>' +
      '<label class="fld">Подпись<input class="field" id="styleLabel" value="' + esc(st.label || '') + '" placeholder="например: усыновление" maxlength="60"></label>' +
      '</div>';
  }
  function readStyleFields(host) {
    var color = host.querySelector('#styleColor').value;
    var dashV = host.querySelector('#styleDash').value;
    var width = parseFloat(host.querySelector('#styleWidth').value);
    var label = host.querySelector('#styleLabel').value.trim();
    var dash = LINE_DASHES[0].a;
    LINE_DASHES.forEach(function (d) { if (d.v === dashV) dash = d.a; });
    var ov = {};
    if (color) ov.color = color;
    if (isFinite(width) && Math.abs(width - 2) > 0.001) ov.width = width;
    if (dash.length) ov.dash = dash;
    if (label) ov.label = label;
    return ov;
  }

  function openRelationEditor(relId) {
    if (!ensureEdit()) return;
    var rel = state.data.relations.find(function (r) { return r.id === relId; });
    if (!rel) return;
    var a = getPerson(rel.a), b = getPerson(rel.b);
    if (!a || !b) return;
    var meta = REL_TYPE_META[rel.type];
    var st = (state.data.appearance.relations && state.data.appearance.relations[relId]) || {};
    var subOpts = meta.opts.map(function (o) {
      return '<option value="' + o.sub + '"' + (o.sub === rel.subtype ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
    var dirHtml = rel.type === 'parent'
      ? '<p class="help-text" style="margin:0 0 12px">Направление: <b>' + esc(FT.personName(a)) + '</b> — родитель, <b>' + esc(FT.personName(b)) + '</b> — ребёнок. <button type="button" class="linkbtn" id="relSwap">Поменять местами</button></p>'
      : '<p class="help-text" style="margin:0 0 12px">Связь: <b>' + esc(FT.personName(a)) + '</b> и <b>' + esc(FT.personName(b)) + '</b>.</p>';

    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Связь: ' + esc(meta.name) + '</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      dirHtml +
      '<label class="fld">Тип связи<select class="field" id="relType">' + subOpts + '</select></label>' +
      '<div class="d-sec" style="margin:14px 0 2px"><h4>Оформление линии</h4></div>' +
      styleFieldsHtml(st) +
      '<div class="modal-actions" style="padding:14px 0 0;border:0;justify-content:space-between">' +
      '<button type="button" class="btn danger-ghost" id="relDelete">Удалить связь</button>' +
      '<span style="display:flex;gap:10px"><button type="button" class="btn" data-close>Отмена</button>' +
      '<button type="button" class="btn primary" id="relSave">Сохранить</button></span>' +
      '</div></div></div>';

    var close = showModal(html);
    var host = $('modalHost');
    var wRange = host.querySelector('#styleWidth');
    wRange.addEventListener('input', function () { host.querySelector('#styleWidthVal').textContent = wRange.value; });

    var swapBtn = host.querySelector('#relSwap');
    if (swapBtn) swapBtn.addEventListener('click', function () {
      pushHistory();
      var tmp = rel.a; rel.a = rel.b; rel.b = tmp;
      saveNow(); recompute(); renderBanner(); close();
      toast('Направление изменено', 'ok');
    });
    host.querySelector('#relDelete').addEventListener('click', function () {
      pushHistory();
      removeRelation(relId);
      saveNow(); recompute(); renderBanner(); close();
      toast('Связь удалена. Люди остались', 'ok');
    });
    host.querySelector('#relSave').addEventListener('click', function () {
      var ov = readStyleFields(host);
      pushHistory();
      rel.subtype = host.querySelector('#relType').value;
      state.data.appearance.relations = state.data.appearance.relations || {};
      if (Object.keys(ov).length) state.data.appearance.relations[relId] = ov;
      else delete state.data.appearance.relations[relId];
      saveNow(); recompute(); renderBanner(); close();
      toast('Связь сохранена', 'ok');
    });
  }

  // ==================== КОНСТРУКТОР: РЕДАКТОР СВОБОДНОЙ ЛИНИИ ====================
  function openFreeLineEditor(id) {
    if (!ensureEdit()) return;
    var fl = (state.data.freeLines || []).find(function (l) { return l.id === id; });
    if (!fl) return;
    var st = { color: fl.color, width: fl.width, dash: fl.dash, label: fl.label };
    var html =
      '<div class="modal">' +
      '<div class="modal-head"><h3>Декоративная линия</h3><button class="icon-btn" data-close aria-label="Закрыть">&#215;</button></div>' +
      '<div class="modal-body">' +
      '<p class="help-text" style="margin:0 0 12px">Это свободная линия для пометок. Она не является родственной связью.</p>' +
      styleFieldsHtml(st) +
      '<label class="fld">Изгиб: <span id="flCurveVal">' + (fl.curve || 0) + '</span><input type="range" min="-200" max="200" step="10" value="' + (fl.curve || 0) + '" id="flCurve" style="width:100%"></label>' +
      '<div class="modal-actions" style="padding:14px 0 0;border:0;justify-content:space-between">' +
      '<button type="button" class="btn danger-ghost" id="flDelete">Удалить линию</button>' +
      '<span style="display:flex;gap:10px"><button type="button" class="btn" data-close>Отмена</button>' +
      '<button type="button" class="btn primary" id="flSave">Сохранить</button></span>' +
      '</div></div></div>';
    var close = showModal(html);
    var host = $('modalHost');
    var wRange = host.querySelector('#styleWidth');
    wRange.addEventListener('input', function () { host.querySelector('#styleWidthVal').textContent = wRange.value; });
    var cRange = host.querySelector('#flCurve');
    cRange.addEventListener('input', function () { host.querySelector('#flCurveVal').textContent = cRange.value; });
    host.querySelector('#flDelete').addEventListener('click', function () {
      pushHistory();
      state.data.freeLines = state.data.freeLines.filter(function (l) { return l.id !== id; });
      saveNow(); recompute(); renderBanner(); close();
      toast('Линия удалена', 'ok');
    });
    host.querySelector('#flSave').addEventListener('click', function () {
      var ov = readStyleFields(host);
      pushHistory();
      fl.color = ov.color || '';
      fl.width = ov.width != null ? ov.width : 2;
      fl.dash = ov.dash || [];
      fl.label = ov.label || '';
      fl.curve = parseInt(host.querySelector('#flCurve').value, 10) || 0;
      saveNow(); recompute(); renderBanner(); close();
      toast('Линия сохранена', 'ok');
    });
  }

  // ==================== КОНСТРУКТОР: ДЕЙСТВИЯ ====================
  function duplicatePerson(id) {
    if (!ensureEdit()) return;
    var p = getPerson(id);
    if (!p) return;
    pushHistory();
    var clone = JSON.parse(JSON.stringify(p));
    clone.id = uid('p');
    clone.name = p.name ? (p.name + ' (копия)') : 'Копия';
    clone.createdAt = Date.now();
    state.data.people.push(clone);
    var n = state.layout ? state.layout.nodes.find(function (x) { return x.id === id; }) : null;
    state.data.positions[clone.id] = n ? { x: Math.round(n.left + 32), y: Math.round(n.top + 32) } : { x: 40, y: 40 };
    saveNow(); recompute();
    selectPerson(clone.id, { center: true, scrollList: true });
    toast('Создана копия (связи не копируются)', 'ok');
  }

  function arrangeTree() {
    if (!ensureEdit()) return;
    if (!state.data.people.length) { toast('Древо пустое', 'warn'); return; }
    var hasManual = state.data.positions && Object.keys(state.data.positions).length;
    if (!hasManual) {
      // Ручных координат нет — раскладка и так автоматическая. Просто покажем всё целиком.
      view.fit(true);
      toast('Дерево уже расположено автоматически', 'ok');
      return;
    }
    confirmModal({
      title: 'Автоматически расположить?',
      html: '<p style="font-size:13.5px">Карточки, которые вы перемещали вручную, вернутся на рассчитанные по родственным связям позиции. ' +
        'Родственные связи, люди и декоративные линии не изменятся.</p>' +
        '<p class="help-text">Действие можно отменить кнопкой «Отменить» (Ctrl+Z).</p>',
      confirmLabel: 'Расположить'
    }).then(function (yes) {
      if (!yes) return;
      pushHistory();
      state.data.positions = {};
      saveNow();
      recompute();
      view.fit(true);
      toast('Древо расположено автоматически', 'ok');
    });
  }

  // Центрирует древо в видимой области, не меняя масштаб.
  function centerTree() {
    if (!state.layout || !state.layout.nodes.length) { toast('Древо пустое', 'warn'); return; }
    view.centerBounds(true);
  }

  function deleteSelected() {
    if (!ensureEdit()) return;
    var ids = Array.from(state.multi);
    if (!ids.length) { toast('Сначала выделите карточки', 'warn'); return; }
    var names = ids.map(function (id) { var p = getPerson(id); return p ? FT.personName(p) : ''; }).filter(Boolean);
    confirmModal({
      title: ids.length > 1 ? 'Удалить выбранных?' : 'Удалить запись?',
      html: '<p style="font-size:13.5px;margin-bottom:6px">Будет удалено: ' + ids.length + ' ' + plural(ids.length, 'запись', 'записи', 'записей') + '.</p>' +
        '<div style="font-size:12.5px;color:var(--dim)">' + esc(names.slice(0, 8).join(', ')) + (names.length > 8 ? ' …' : '') + '</div>' +
        '<p class="help-text">Их родственные связи тоже удалятся. Действие можно отменить кнопкой «Отменить».</p>',
      confirmLabel: 'Удалить',
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      pushHistory();
      ids.forEach(function (id) { deletePerson(id); state.collapsed.delete(id); });
      saveCollapsed();
      state.multi = new Set();
      state.selection = null;
      saveNow(); recompute();
      toast('Удалено', 'ok');
    });
  }

  // ==================== КОНСТРУКТОР: ПЕРЕТАСКИВАНИЕ / ПОТОКИ ====================
  function onNodeDragStart(id) {
    if (!ensureEdit()) return;
    if (!state.layout) return;
    var ids = (state.multi.has(id) && state.multi.size > 1) ? Array.from(state.multi) : [id];
    var start = {};
    ids.forEach(function (nid) {
      var n = state.layout.nodes.find(function (x) { return x.id === nid; });
      if (n) start[nid] = { x: n.left, y: n.top };
    });
    state.dragCtx = { ids: ids, start: start };
    pushHistory();
  }
  function onNodeDragMove(dx, dy) {
    var ctx = state.dragCtx;
    if (!ctx || !state.data.positions) return;
    ctx.ids.forEach(function (nid) {
      var s = ctx.start[nid];
      if (!s) return;
      state.data.positions[nid] = { x: Math.round(s.x + dx), y: Math.round(s.y + dy) };
    });
    relayout();
  }
  function onNodeDragEnd() {
    var ctx = state.dragCtx;
    state.dragCtx = null;
    if (!ctx) return;
    saveNow();
    renderBanner();
  }

  function onMarqueeEnd(x1, y1, x2, y2, moved) {
    if (!moved || !state.layout) return;
    var minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    var ids = state.layout.nodes.filter(function (n) {
      return n.cx >= minX && n.cx <= maxX && n.cy >= minY && n.cy <= maxY;
    }).map(function (n) { return n.id; });
    state.multi = new Set(ids);
    state.selection = ids.length ? ids[ids.length - 1] : null;
    view.setSelection(state.multi);
    renderList();
    renderDetails();
    if (ids.length) toast('Выделено: ' + ids.length, 'ok');
  }

  function onConnectEnd(fromId, toId, moved) {
    if (!fromId) return;
    if (toId && toId !== fromId) {
      openConnectModal(getPerson(fromId), { other: toId, title: 'Связь между людьми' });
      return;
    }
    if (!moved) selectPerson(fromId, {});
  }

  function onLineClick(wx, wy) {
    if (!ensureEdit()) return;
    if (!state.lineStart) {
      state.lineStart = { x: Math.round(wx), y: Math.round(wy) };
      view.setPreview(state.lineStart.x, state.lineStart.y, state.lineStart.x, state.lineStart.y);
      toast('Отметьте вторую точку линии', 'ok');
      return;
    }
    var s = state.lineStart;
    state.lineStart = null;
    view.clearPreview();
    if (Math.abs(s.x - wx) < 4 && Math.abs(s.y - wy) < 4) return;
    pushHistory();
    state.data.freeLines = state.data.freeLines || [];
    state.data.freeLines.push({
      id: uid('fl'), x1: s.x, y1: s.y, x2: Math.round(wx), y2: Math.round(wy),
      color: state.ui.lastLineColor || '', width: 2, dash: [], curve: 0, label: ''
    });
    saveNow(); recompute(); renderBanner();
    toast('Линия добавлена. Нажмите на неё, чтобы изменить', 'ok');
  }
  function onHover(wx, wy) {
    if (state.tool === 'line' && state.lineStart) {
      view.setPreview(state.lineStart.x, state.lineStart.y, wx, wy);
    }
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    var t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function canvasHit(wx, wy) {
    if (!state.layout) return null;
    var best = null, bestD = 14;
    (state.data.freeLines || []).forEach(function (l) {
      var d = distToSeg(wx, wy, l.x1, l.y1, l.x2, l.y2);
      if (d < bestD) { bestD = d; best = { kind: 'free', id: l.id }; }
    });
    var nodes = state.layout.nodes;
    function nodeOf(id) { for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i]; return null; }
    state.data.relations.forEach(function (r) {
      var a = nodeOf(r.a), b = nodeOf(r.b);
      if (!a || !b) return;
      var d = (r.type === 'parent')
        ? distToSeg(wx, wy, a.cx, a.bottom, b.cx, b.top)
        : distToSeg(wx, wy, a.cx, a.cy, b.cx, b.cy);
      if (d < bestD) { bestD = d; best = { kind: 'relation', id: r.id }; }
    });
    return best;
  }
  function onCanvasClick(wx, wy) {
    var hit = canvasHit(wx, wy);
    if (hit && hit.kind === 'free') { openFreeLineEditor(hit.id); return; }
    if (hit && hit.kind === 'relation') { openRelationEditor(hit.id); return; }
    selectPerson(null, {});
  }

  // ==================== СОБЫТИЯ ====================
  function bindUI() {
    $('btnSidebar').addEventListener('click', function () {
      var sb = $('sidebar');
      var open = sb.classList.toggle('open');
      $('sideBackdrop').hidden = !open;
    });
    $('sideBackdrop').addEventListener('click', function () {
      $('sidebar').classList.remove('open');
      $('sideBackdrop').hidden = true;
    });

    $('search').addEventListener('input', function (e) {
      state.search = e.target.value;
      $('searchClear').hidden = !state.search;
      renderList();
    });
    $('searchClear').addEventListener('click', function () {
      state.search = '';
      $('search').value = '';
      $('searchClear').hidden = true;
      renderList();
      $('search').focus();
    });

    $('peopleList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-id]');
      if (!b) return;
      if (isNarrow()) {
        closeSidebar();
      }
      selectPerson(b.getAttribute('data-id'), { center: true });
    });

    $('detailsHost').addEventListener('click', function (e) {
      var addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        e.stopPropagation();
        openAddMenu(addBtn, getPerson(state.selection), addBtn.getAttribute('data-add'));
        return;
      }
      var unlink = e.target.closest('[data-unlink]');
      if (unlink) {
        e.stopPropagation();
        confirmUnlink(unlink.getAttribute('data-unlink'));
        return;
      }
      var goto = e.target.closest('[data-goto]');
      if (goto) { selectPerson(goto.getAttribute('data-goto'), { center: true, scrollList: true }); return; }
      var act = e.target.closest('[data-act]');
      if (act) { detailsAction(act.getAttribute('data-act')); }
    });

    $('btnAdd').addEventListener('click', function () {
      if (!state.data.people.length) { openPersonForm({ title: 'Первый человек в древе' }); return; }
      openPersonForm({ title: 'Новый родственник' });
    });
    $('btnFit').addEventListener('click', function () { view.fit(true); });
    $('btnFitIcon').addEventListener('click', function () { view.fit(true); });
    if ($('btnArrange')) $('btnArrange').addEventListener('click', arrangeTree);
    if ($('btnCenter')) $('btnCenter').addEventListener('click', centerTree);
    if ($('btnCenterIcon')) $('btnCenterIcon').addEventListener('click', centerTree);
    $('btnTheme').addEventListener('click', toggleTheme);
    $('btnMenu').addEventListener('click', function () { openMainMenu($('btnMenu')); });
    $('btnGenFilter').addEventListener('click', openGenFilter);

    var cloudBtn = $('btnCloud');
    if (cloudBtn) cloudBtn.addEventListener('click', openCollaborators);
    var cloudBar = $('cloudBar');
    if (cloudBar) cloudBar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-cloud]');
      if (!b) return;
      if (b.getAttribute('data-cloud') === 'history') openHistory();
      else openCollaborators();
    });

    $('zoomIn').addEventListener('click', function () { view.zoomBy(1.2, true); });
    $('zoomOut').addEventListener('click', function () { view.zoomBy(1 / 1.2, true); });

    // панель инструментов конструктора
    Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'), function (b) {
      b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
    });
    if ($('toolAdd')) $('toolAdd').addEventListener('click', function () { menuAction('add'); });
    if ($('toolConnect')) $('toolConnect').addEventListener('click', startConnectFromSelection);
    if ($('toolUndo')) $('toolUndo').addEventListener('click', undo);
    if ($('toolRedo')) $('toolRedo').addEventListener('click', redo);
    if ($('toolArrange')) $('toolArrange').addEventListener('click', arrangeTree);
    if ($('toolCenter')) $('toolCenter').addEventListener('click', centerTree);
    if ($('toolDelete')) $('toolDelete').addEventListener('click', deleteSelected);

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ($('modalHost').firstChild) return;
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (e.key === 'Delete') { if (state.multi.size) { e.preventDefault(); deleteSelected(); } return; }
      if (e.key === 'Escape') { setTool('move'); closePopover(); return; }
    });

    $('emptyAdd').addEventListener('click', function () { openPersonForm({ title: 'Первый человек в древе' }); });
    $('emptyDemo').addEventListener('click', enterDemo);

    $('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleImportFile(f);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  function detailsAction(act) {
    var p = getPerson(state.selection);
    if (!p) return;
    if (act !== 'close' && act !== 'collapse' && !ensureEdit()) return;
    if (act === 'close') { selectPerson(null); return; }
    if (act === 'edit') { openPersonForm({ person: p, title: 'Редактировать: ' + FT.personName(p) }); return; }
    if (act === 'connect') { openConnectModal(p, {}); return; }
    if (act === 'duplicate') { duplicatePerson(p.id); return; }
    if (act === 'link') { openLinkModal(p, 'parent'); return; }
    if (act === 'collapse') { toggleCollapse(p.id); return; }
    if (act === 'delete') {
      confirmModal({
        title: 'Удалить запись?',
        html: '<p style="font-size:13.5px;margin-bottom:8px">Удалить <b>' + esc(FT.personName(p)) + '</b>?</p>' +
          '<p class="help-text">Запись человека и его связи будут удалены. Остальные родственники сохранятся. Действие нельзя отменить.</p>',
        confirmLabel: 'Удалить',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        pushHistory();
        deletePerson(p.id);
        state.collapsed.delete(p.id);
        saveCollapsed();
        save();
        selectPerson(null);
        recompute();
        toast('Запись удалена', 'ok');
      });
    }
  }

  function confirmUnlink(relId) {
    var rel = state.data.relations.find(function (r) { return r.id === relId; });
    if (!rel) return;
    var a = getPerson(rel.a), b = getPerson(rel.b);
    if (!a || !b) return;
    confirmModal({
      title: 'Убрать связь?',
      html: '<p style="font-size:13.5px">Убрать связь между <b>' + esc(FT.personName(a)) + '</b> и <b>' + esc(FT.personName(b)) + '</b>? ' +
        'Записи людей останутся, изменится только родственная связь.</p>',
      confirmLabel: 'Убрать'
    }).then(function (yes) {
      if (!yes) return;
      pushHistory();
      removeRelation(relId);
      save();
      recompute();
      toast('Связь убрана', 'ok');
    });
  }

  // ==================== ПРИЛОЖЕНИЕ ====================
  function init() {
    loadUI();
    applyTheme(state.ui.theme || systemTheme());
    state.mode = state.ui.mode === 'demo' ? 'demo' : 'real';
    if (state.mode === 'demo') state.ui.mode = 'demo';

    view = FT.createView({
      canvas: $('canvas'),
      world: $('world'),
      svg: $('edges'),
      nodesEl: $('nodes'),
      getTool: function () { return state.tool; },
      onSelect: function (id, o) {
        if (id && isNarrow()) { closeSidebar(); }
        selectPerson(id, { additive: !!(o && o.additive) });
      },
      onCollapse: function (id) { toggleCollapse(id); },
      onNodeDragStart: onNodeDragStart,
      onNodeDragMove: onNodeDragMove,
      onNodeDragEnd: onNodeDragEnd,
      onMarqueeEnd: onMarqueeEnd,
      onConnectStart: function (id) { if (id) selectPerson(id, {}); },
      onConnectEnd: onConnectEnd,
      onLineClick: onLineClick,
      onHover: onHover,
      onCanvasClick: onCanvasClick
    });

    setTool('move');
    updateToolsUI();
    updateHistoryUI();

    bindUI();
    loadData();
    loadCollapsed();
    recompute();
    renderBanner();
    renderWelcome();
    view.fit(false);
    initCloud();

    if (state.ui.theme === null) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
          if (state.ui.theme === null) applyTheme(e.matches ? 'dark' : 'light');
        });
      } catch (err) { /* старые браузеры */ }
    }

    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
