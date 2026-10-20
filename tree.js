/* ============================================================
   Семейное древо — движок: раскладка, отрисовка SVG, pan/zoom, PNG.
   Чистые функции раскладки не зависят от DOM (можно тестировать).
   ============================================================ */
'use strict';

var FT = (function () {
  // ---------- размеры ----------
  var CARD_W = 182;
  var CARD_H = 64;
  var LEVEL_GAP = 104;              // вертикальный зазор между поколениями
  var LEVEL_H = CARD_H + LEVEL_GAP; // расстояние между рядами
  var MEMBER_GAP = 24;              // зазор между партнёрами внутри «ячейки»
  var H_GAP = 42;                   // зазор между соседними «ячейками»
  var GROUP_GAP = 96;               // зазор между несвязанными семьями
  var BUS_OFFSET = 46;              // высота «шины» над карточкой ребёнка
  var LANE_STEP = 11;               // смещение шин разных союзов на одном ряду
  var KNOT_R = 3.6;                 // радиус точки-«узла» союза
  var MIN_K = 0.18;
  var MAX_K = 2.6;
  var FIT_MIN_K = 0.05;             // «Показать всё» может отдалиться сильнее, чтобы вместить широкое древо

  var GEN_VARS = ['--gen-0', '--gen-1', '--gen-2', '--gen-3', '--gen-4', '--gen-5'];

  // ============================================================
  // Утилиты
  // ============================================================
  function yearOf(s) {
    var m = String(s == null ? '' : s).match(/(1[5-9]\d\d|20\d\d|21\d\d)/);
    return m ? parseInt(m[0], 10) : null;
  }

  function personName(p) {
    if (!p) return 'Без имени';
    var n = [p.name, p.surname].filter(Boolean).join(' ').trim();
    if (!n) n = p.surname || p.name || '';
    return n || 'Без имени';
  }

  function isUnnamed(p) {
    return !(p && (p.name || p.surname));
  }

  function initials(p) {
    if (!p) return '?';
    var a = (p.name || '').trim();
    var b = (p.surname || '').trim();
    var x = (a ? a[0] : '') + (b ? b[0] : '');
    if (!x) x = (p.surname || p.name || '').slice(0, 2);
    return (x || '?').toUpperCase();
  }

  function personYears(p) {
    if (!p) return '';
    var by = yearOf(p.birthDate);
    var dy = yearOf(p.deathDate);
    if (by && dy) return by + '\u2013' + dy;
    if (by) {
      var age = new Date().getFullYear() - by;
      if (age >= 0 && age <= 130) return '\u0440\u043e\u0434. ' + by + ' \u00b7 ' + age + ' \u043b\u0435\u0442';
      return '\u0440\u043e\u0434. ' + by;
    }
    if (dy) return '\u2020 ' + dy;
    return '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function avatarHtml(p, cls) {
    if (p && p.photo) {
      return '<span class="' + cls + '"><img src="' + escapeHtml(p.photo) + '" alt=""></span>';
    }
    return '<span class="' + cls + '">' + escapeHtml(initials(p)) + '</span>';
  }

  // ============================================================
  // РАСКЛАДКА (чистая функция)
  //
  // Модель: «союз» (union) — это пара (или один родитель) и его дети.
  //   • детей привязываем к союзу, а не к отдельному родителю;
  //   • у каждого союза своя «шина» (горизонтальная линия) только
  //     над своими детьми — поэтому шины разных союзов не сливаются;
  //   • союз помечается точкой-«узлом» между партнёрами;
  //   • дети одного союза всегда идут подряд (нет «сирот» между ветвями).
  // ============================================================
  function computeLayout(data, collapsedSet) {
    var people = (data && data.people) || [];
    var rels = (data && data.relations) || [];
    var collapsed = collapsedSet || [];
    if (typeof collapsed.indexOf !== 'function') collapsed = Array.from(collapsed);

    var byId = new Map();
    people.forEach(function (p, i) { byId.set(p.id, { p: p, i: i }); });

    var parLinks = [], spLinks = [], sibLinks = [], unkLinks = [];
    rels.forEach(function (r) {
      if (!r) return;
      if (r.type === 'parent' && byId.has(r.a) && byId.has(r.b) && r.a !== r.b) {
        parLinks.push({ id: r.id, a: r.a, b: r.b, sub: r.subtype || 'bio' });
      } else if (r.type === 'spouse' && byId.has(r.a) && byId.has(r.b) && r.a !== r.b) {
        spLinks.push({ id: r.id, a: r.a, b: r.b, sub: r.subtype || 'married' });
      } else if (r.type === 'sibling' && byId.has(r.a) && byId.has(r.b) && r.a !== r.b) {
        sibLinks.push({ id: r.id, a: r.a, b: r.b, sub: r.subtype || 'bio' });
      } else if (r.type === 'unknown' && byId.has(r.a) && byId.has(r.b) && r.a !== r.b) {
        unkLinks.push({ id: r.id, a: r.a, b: r.b });
      }
    });

    // Свободное расположение: координаты, заданные пользователем, и декоративные линии.
    var positions = (data && data.positions) || {};
    var appearance = (data && data.appearance) || {};
    var relStyle = appearance.relations || {};
    var rawFree = (data && Array.isArray(data.freeLines)) ? data.freeLines : [];

    function styleFor(rids) {
      for (var i = 0; i < rids.length; i++) {
        var s = relStyle[rids[i]];
        if (s && (s.color != null || s.width != null || (s.dash && s.dash.length))) return s;
      }
      return null;
    }
    function labelOf(rids) {
      for (var i = 0; i < rids.length; i++) {
        var s = relStyle[rids[i]];
        if (s && s.label) return s.label;
      }
      return '';
    }

    // Структурные связи (родные/приёмные): задают родословную.
    // Отчим/мачеха (sub === 'step') влияет только на отрисовку.
    var structLinks = parLinks.filter(function (l) { return l.sub !== 'step'; });

    // ---- смежности ----
    var parentsOf = new Map(), childrenOf = new Map(), spouseAdj = new Map(), allAdj = new Map();
    function push(map, k, v) {
      var arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      if (arr.indexOf(v) < 0) arr.push(v);
    }
    structLinks.forEach(function (l) { push(parentsOf, l.b, l.a); push(childrenOf, l.a, l.b); });
    parLinks.forEach(function (l) { push(allAdj, l.a, l.b); push(allAdj, l.b, l.a); });
    spLinks.forEach(function (l) {
      push(spouseAdj, l.a, l.b); push(spouseAdj, l.b, l.a);
      push(allAdj, l.a, l.b); push(allAdj, l.b, l.a);
    });
    // Брат/сестра объединяют людей в одну семью даже без общих родителей.
    // Неизвестную (неподтверждённую) связь намеренно НЕ используем для группировки,
    // чтобы такой человек не прибивался к чужой ветке — он остаётся в отдельной области.
    sibLinks.forEach(function (l) { push(allAdj, l.a, l.b); push(allAdj, l.b, l.a); });

    // ---- скрытые ветви (потомки свёрнутых) ----
    var hidden = new Set();
    var hiddenCount = new Map();
    collapsed.forEach(function (c) {
      if (!byId.has(c)) return;
      var stack = (childrenOf.get(c) || []).slice();
      var seen = new Set();
      while (stack.length) {
        var x = stack.pop();
        if (seen.has(x)) continue;
        seen.add(x);
        hidden.add(x);
        (childrenOf.get(x) || []).forEach(function (y) { stack.push(y); });
      }
      hiddenCount.set(c, seen.size);
    });

    var ids = people.map(function (p) { return p.id; }).filter(function (id) { return !hidden.has(id); });

    if (!ids.length) {
      var flOnly = [];
      var fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
      rawFree.forEach(function (fl, i) {
        if (!fl) return;
        var x1 = Number(fl.x1), y1 = Number(fl.y1), x2 = Number(fl.x2), y2 = Number(fl.y2);
        if (![x1, y1, x2, y2].every(isFinite)) return;
        var o = {
          id: typeof fl.id === 'string' && fl.id ? fl.id : ('fl' + i),
          x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2),
          color: typeof fl.color === 'string' ? fl.color : '',
          width: isFinite(fl.width) ? Math.max(1, Math.min(12, fl.width)) : 2,
          dash: Array.isArray(fl.dash) ? fl.dash.filter(function (n) { return isFinite(n); }).slice(0, 4) : [],
          curve: isFinite(fl.curve) ? fl.curve : 0,
          label: typeof fl.label === 'string' ? fl.label.slice(0, 60) : ''
        };
        flOnly.push(o);
        fx0 = Math.min(fx0, x1, x2); fx1 = Math.max(fx1, x1, x2);
        fy0 = Math.min(fy0, y1, y2); fy1 = Math.max(fy1, y1, y2);
      });
      if (!flOnly.length) {
        return { nodes: [], segments: [], freeLines: [], labels: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 }, levels: 0, groups: 0 };
      }
      return {
        nodes: [], segments: [], freeLines: flOnly, labels: [],
        bounds: { minX: fx0, minY: fy0, maxX: fx1, maxY: fy1, w: fx1 - fx0, h: fy1 - fy0 },
        levels: 0, groups: 0
      };
    }

    function idxOf(id) { var e = byId.get(id); return e ? e.i : 0; }
    function birthOf(id) { return yearOf(byId.get(id).p.birthDate); }
    function cmpBirth(a, b) {
      var ya = birthOf(a), yb = birthOf(b);
      if (ya != null && yb != null && ya !== yb) return ya - yb;
      if (ya != null && yb == null) return -1;
      if (ya == null && yb != null) return 1;
      return idxOf(a) - idxOf(b);
    }

    // ---- уровни (поколения) ----
    var lvl = new Map();
    ids.forEach(function (id) { lvl.set(id, 0); });

    var coParentGroups = [];
    parentsOf.forEach(function (ps, child) {
      if (hidden.has(child)) return;
      var vis = ps.filter(function (x) { return !hidden.has(x); });
      if (vis.length >= 2) coParentGroups.push(vis);
    });

    var MAX_IT = ids.length * 2 + 20;
    for (var it = 0; it < MAX_IT; it++) {
      var changed = false;
      structLinks.forEach(function (l) {
        if (hidden.has(l.a) || hidden.has(l.b)) return;
        if (lvl.get(l.b) < lvl.get(l.a) + 1) { lvl.set(l.b, lvl.get(l.a) + 1); changed = true; }
      });
      spLinks.forEach(function (l) {
        if (hidden.has(l.a) || hidden.has(l.b)) return;
        var m = Math.max(lvl.get(l.a), lvl.get(l.b));
        if (lvl.get(l.a) !== m) { lvl.set(l.a, m); changed = true; }
        if (lvl.get(l.b) !== m) { lvl.set(l.b, m); changed = true; }
      });
      // братья/сёстры — одно поколение (даже если родителей нет)
      sibLinks.forEach(function (l) {
        if (hidden.has(l.a) || hidden.has(l.b)) return;
        var m = Math.max(lvl.get(l.a), lvl.get(l.b));
        if (lvl.get(l.a) !== m) { lvl.set(l.a, m); changed = true; }
        if (lvl.get(l.b) !== m) { lvl.set(l.b, m); changed = true; }
      });
      coParentGroups.forEach(function (grp) {
        var m = -1;
        grp.forEach(function (x) { if (lvl.get(x) > m) m = lvl.get(x); });
        grp.forEach(function (x) { if (lvl.get(x) < m) { lvl.set(x, m); changed = true; } });
      });
      if (!changed) break;
    }

    // ---- союзы ----
    var structParents = new Map();
    structLinks.forEach(function (l) {
      if (hidden.has(l.a) || hidden.has(l.b)) return;
      push(structParents, l.b, l.a);
    });

    var unionByKey = {}, unions = [];
    function getUnion(partners) {
      var key = partners.slice().sort().join('\u0001');
      var u = unionByKey[key];
      if (!u) {
        u = { id: 'u' + unions.length, key: key, partners: [], children: [], subtype: 'single' };
        unionByKey[key] = u;
        unions.push(u);
      }
      partners.forEach(function (p) { if (u.partners.indexOf(p) < 0) u.partners.push(p); });
      return u;
    }

    spLinks.forEach(function (l) {
      if (hidden.has(l.a) || hidden.has(l.b)) return;
      var u = getUnion([l.a, l.b]);
      if (l.sub === 'partner') u.subtype = 'partner';
      else if (u.subtype !== 'partner') u.subtype = 'married';
    });

    var unionOfChild = {};
    var childStyle = {};
    ids.forEach(function (cid) {
      var ps = structParents.get(cid);
      if (!ps || !ps.length) return;
      var vis = ps.filter(function (x) { return !hidden.has(x); });
      if (!vis.length) return;
      var u = getUnion(vis);
      if (u.children.indexOf(cid) < 0) u.children.push(cid);
      unionOfChild[cid] = u.id;
    });
    structLinks.forEach(function (l) {
      if (hidden.has(l.a) || hidden.has(l.b)) return;
      if (l.sub === 'adoptive') { if (!childStyle[l.b]) childStyle[l.b] = 'adoptive'; }
      else childStyle[l.b] = 'bio';
    });

    var unionById = {};
    unions = unions.filter(function (u) {
      u.partners = u.partners.filter(function (p) { return !hidden.has(p); });
      u.children = u.children.filter(function (c) { return !hidden.has(c); }).sort(cmpBirth);
      if (!u.partners.length) return false;
      if (u.partners.length >= 2 && u.subtype === 'single') u.subtype = 'married';
      u.level = lvl.get(u.partners[0]);
      unionById[u.id] = u;
      return true;
    });

    var unionsOf = {};
    unions.forEach(function (u) { u.partners.forEach(function (p) { (unionsOf[p] = unionsOf[p] || []).push(u); }); });

    // ---- «ячейки» (связанные партнёры одного ряда) ----
    var unitOf = new Map(), units = [];
    function spacing(m) { return (spouseAdj.get(m) || []).filter(function (y) { return !hidden.has(y); }).length; }
    ids.forEach(function (id) {
      if (unitOf.has(id)) return;
      var members = [], q = [id], seen = new Set([id]);
      while (q.length) {
        var x = q.shift();
        members.push(x);
        (spouseAdj.get(x) || []).forEach(function (y) {
          if (!seen.has(y) && !hidden.has(y)) { seen.add(y); q.push(y); }
        });
      }
      // самый «связный» партнёр — в центр, остальные по сторонам
      members.sort(function (a, b) { var d = spacing(b) - spacing(a); return d || (idxOf(a) - idxOf(b)); });
      var ordered = [];
      members.forEach(function (m, k) {
        if (k === 0) ordered.push(m);
        else if (k % 2 === 1) ordered.push(m);
        else ordered.unshift(m);
      });
      var unit = { members: ordered, level: lvl.get(ordered[0]), width: 0, half: 0, x: 0, desired: 0 };
      unit.width = ordered.length * CARD_W + (ordered.length - 1) * MEMBER_GAP;
      unit.half = unit.width / 2;
      ordered.forEach(function (m) { unitOf.set(m, unit); });
      units.push(unit);
    });

    // ---- связные компоненты (несвязанные семьи) ----
    var compOf = new Map(), comps = [];
    ids.forEach(function (id) {
      if (compOf.has(id)) return;
      var g = comps.length;
      comps.push([]);
      var stack = [id];
      compOf.set(id, g);
      while (stack.length) {
        var x = stack.pop();
        comps[g].push(x);
        (allAdj.get(x) || []).forEach(function (y) {
          if (!hidden.has(y) && !compOf.has(y)) { compOf.set(y, g); stack.push(y); }
        });
      }
    });

    // ---- родительская «ячейка» (для вложенной компактной раскладки) ----
    units.forEach(function (u, i) {
      u._ord = i;
      u.parentUnion = null;
      for (var k = 0; k < u.members.length; k++) {
        var uid = unionOfChild[u.members[k]];
        if (uid) { u.parentUnion = unionById[uid]; break; }
      }
    });

    // индекс участника союза вдоль «ячейки» — задаёт порядок союзов слева-направо
    function anchorIndex(host, union) {
      var t = 0, n = 0;
      union.partners.forEach(function (p) {
        var k = host.members.indexOf(p);
        if (k >= 0) { t += k; n++; }
      });
      return n ? t / n : 0;
    }

    // дети каждой «ячейки» по реальным связям (сгруппированы по союзам)
    var childrenMap = new Map();
    units.forEach(function (u) {
      var pu = u.parentUnion;
      if (!pu) return;
      var host = null;
      for (var i = 0; i < pu.partners.length && !host; i++) host = unitOf.get(pu.partners[i]);
      if (!host || host === u) return;
      var list = childrenMap.get(host);
      if (!list) { list = []; childrenMap.set(host, list); }
      list.push({ u: u, anchor: anchorIndex(host, pu) });
    });
    childrenMap.forEach(function (list) {
      list.sort(function (x, y) {
        if (x.anchor !== y.anchor) return x.anchor - y.anchor;
        var d = cmpBirth(x.u.members[0], y.u.members[0]);
        if (d) return d;
        return x.u._ord - y.u._ord;
      });
    });

    // ---- измерение ширины поддерева (снизу вверх) ----
    var sw = new Map();
    var childOrder = new Map();
    function measure(u, path) {
      if (sw.has(u)) return sw.get(u);
      path.add(u);
      var list = childrenMap.get(u) || [];
      var parts = [];
      var total = 0;
      list.forEach(function (c) {
        if (path.has(c.u)) return;      // разрыв зацикленных связей
        var w = measure(c.u, path);
        parts.push({ u: c.u, w: w });
        total += w + H_GAP;
      });
      if (parts.length) total -= H_GAP;
      childOrder.set(u, parts);
      var w = Math.max(u.width, parts.length ? total : 0);
      sw.set(u, w);
      path.delete(u);
      return w;
    }

    // ---- размещение поддерева (сверху вниз): родители по центру детей ----
    function placeUnit(u, x0) {
      var parts = childOrder.get(u) || [];
      var total = 0;
      parts.forEach(function (p) { total += p.w + H_GAP; });
      if (parts.length) total -= H_GAP;
      var w = sw.get(u);
      var start = x0 + (w - total) / 2;
      var cur = start;
      parts.forEach(function (p) { placeUnit(p.u, cur); cur += p.w + H_GAP; });
      var center = parts.length ? (start + total / 2) : (x0 + w / 2);
      u.centerX = center;
      u.leftX = center - u.width / 2;
    }

    // корни: «ячейки» без родителя. Обходим по поколениям, чтобы родители
    // были измерены раньше детей (устойчиво к циклам и «родителям-призракам»).
    var roots = [];
    units.slice().sort(function (a, b) {
      if (a.level !== b.level) return a.level - b.level;
      return a._ord - b._ord;
    }).forEach(function (u) {
      if (sw.has(u)) return;
      roots.push(u);
      measure(u, new Set());
    });

    // минимальное поколение каждой семейной группы (для вертикального сдвига)
    var compMinLvl = new Map();
    units.forEach(function (u) {
      var c = compOf.get(u.members[0]);
      var cur = compMinLvl.get(c);
      if (cur == null || u.level < cur) compMinLvl.set(c, u.level);
    });

    // ---- финальные координаты ----
    var nodes = [];
    var nodeById = new Map();

    // корни слева-направо: внутри группы — H_GAP, между группами — GROUP_GAP
    var placeList = roots.slice().sort(function (a, b) {
      var ca = compOf.get(a.members[0]), cb = compOf.get(b.members[0]);
      if (ca !== cb) return ca - cb;
      if (a.level !== b.level) return a.level - b.level;
      return a._ord - b._ord;
    });
    var curX = 0, prevComp = -1;
    placeList.forEach(function (r) {
      var comp = compOf.get(r.members[0]);
      if (prevComp !== -1) curX += (comp === prevComp ? H_GAP : GROUP_GAP);
      placeUnit(r, curX);
      curX += sw.get(r);
      prevComp = comp;
    });

    units.forEach(function (u) {
      var comp = compOf.get(u.members[0]);
      var yBase = (u.level - (compMinLvl.get(comp) || 0)) * LEVEL_H;
      var left = (u.leftX == null) ? 0 : u.leftX;
      u.members.forEach(function (id, mi) {
        var x = left + mi * (CARD_W + MEMBER_GAP);
        var y = yBase;
        var childArr = childrenOf.get(id) || [];
        var isCollapsed = collapsed.indexOf(id) >= 0;
        var node = {
          id: id,
          x: x,
          y: y,
          cx: x + CARD_W / 2,
          cy: y + CARD_H / 2,
          gen: u.level,
          left: x,
          top: y,
          right: x + CARD_W,
          bottom: y + CARD_H,
          hasChildren: childArr.length > 0,
          collapsed: isCollapsed,
          hiddenDesc: isCollapsed ? (hiddenCount.get(id) || 0) : 0
        };
        nodes.push(node);
        nodeById.set(id, node);
      });
    });

    // ---- порядок супругов: каждый встаёт со стороны своей родословной ----
    // Слева от человека должна быть его семейная ветка (родители/братья),
    // справа — ветка супруга. Меняем местами только карточки внутри пары;
    // связи, дети и другие ветки не затрагиваются. Ширина пары не меняется,
    // поэтому остальная раскладка и повторный запуск остаются стабильными.
    var coupleStep = CARD_W + MEMBER_GAP;
    units.forEach(function (u) {
      if (u.members.length !== 2) return;
      var anchors = u.members.map(function (m) {
        var uid = unionOfChild[m];
        var pu = uid ? unionById[uid] : null;
        if (!pu) return null;
        var t = 0, n = 0;
        pu.partners.forEach(function (p) {
          var nd = nodeById.get(p);
          if (nd) { t += nd.cx; n++; }
        });
        return n ? t / n : null;
      });
      if (anchors[0] == null || anchors[1] == null) return; // не оба «кровные» — не трогаем
      if (anchors[0] <= anchors[1]) return;                 // уже верный порядок
      u.members.reverse();                                  // чей род левее — тот и левее
      u.members.forEach(function (id, i) {
        var n = nodeById.get(id);
        if (!n) return;
        var x = u.leftX + i * coupleStep;
        n.x = x; n.left = x; n.right = x + CARD_W; n.cx = x + CARD_W / 2;
      });
    });

    // Свободное расположение: накладываем координаты, заданные пользователем.
    // Карточки без своих координат остаются на местах, рассчитанных автоматически.
    nodes.forEach(function (n) {
      var pp = positions[n.id];
      if (pp && isFinite(pp.x) && isFinite(pp.y)) {
        n.x = pp.x;
        n.y = pp.y;
        n.cx = pp.x + CARD_W / 2;
        n.cy = pp.y + CARD_H / 2;
        n.left = pp.x;
        n.top = pp.y;
        n.right = pp.x + CARD_W;
        n.bottom = pp.y + CARD_H;
      }
    });

    // ---- рёбра ----
    var segments = [];
    var labels = [];
    function seg(o) { o.rids = o.rids || []; o.st = o.rids.length ? styleFor(o.rids) : null; segments.push(o); }
    function line(x1, y1, x2, y2, cls, pids, rids) {
      seg({ t: 'l', x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), cls: cls, pids: pids, rids: rids });
    }
    function quad(x1, y1, cx, cy, x2, y2, cls, pids, rids) {
      seg({ t: 'q', x1: r1(x1), y1: r1(y1), cx: r1(cx), cy: r1(cy), x2: r1(x2), y2: r1(y2), cls: cls, pids: pids, rids: rids });
    }
    function knot(x, y, pids, rids) {
      seg({ t: 'c', x1: r1(x), y1: r1(y), r: KNOT_R, cls: 'knot', pids: pids, rids: rids });
    }
    function labelAt(x, y, text, rids, cls) {
      if (!text) return;
      labels.push({ x: r1(x), y: r1(y), text: String(text).slice(0, 60), rids: rids || [], cls: cls || '' });
    }

    var busSpecs = [];

    unions.forEach(function (u) {
      var pnodes = u.partners.map(function (p) { return nodeById.get(p); }).filter(Boolean);
      if (!pnodes.length) return;
      var pids = u.partners.slice();
      var unionPointX, stemTopY;

      if (pnodes.length >= 2) {
        var sorted = pnodes.slice().sort(function (a, b) { return a.cx - b.cx; });
        var leftN = sorted[0], rightN = sorted[sorted.length - 1];
        var cls = u.subtype === 'partner' ? 'partner' : 'spouse';
        var spouseRids = spLinks.filter(function (l) {
          return (l.a === leftN.id && l.b === rightN.id) || (l.a === rightN.id && l.b === leftN.id);
        }).map(function (l) { return l.id; });
        var adjacent = Math.abs(leftN.cx - rightN.cx) <= (CARD_W + MEMBER_GAP + 2);
        if (leftN.y === rightN.y && adjacent) {
          line(leftN.right, leftN.y + CARD_H / 2, rightN.left, rightN.y + CARD_H / 2, cls, pids, spouseRids);
          unionPointX = (leftN.cx + rightN.cx) / 2;
          stemTopY = leftN.y + CARD_H;
          labelAt(unionPointX, leftN.y + CARD_H / 2 - 6, labelOf(spouseRids), spouseRids, 'lbl-spouse');
          if (u.children.length) knot(unionPointX, leftN.y + CARD_H / 2, pids, spouseRids);
        } else if (leftN.y === rightN.y) {
          var yb = leftN.y + CARD_H;
          quad(leftN.cx, yb, (leftN.cx + rightN.cx) / 2, yb + 34, rightN.cx, yb, cls, pids, spouseRids);
          unionPointX = (leftN.cx + rightN.cx) / 2;
          stemTopY = yb + 17;
          if (u.children.length) knot(unionPointX, stemTopY, pids, spouseRids);
        } else {
          var midY = (leftN.cy + rightN.cy) / 2 + 30;
          quad(leftN.cx, leftN.y + CARD_H, (leftN.cx + rightN.cx) / 2, midY, rightN.cx, rightN.y + CARD_H, cls, pids, spouseRids);
          unionPointX = (leftN.cx + rightN.cx) / 2;
          stemTopY = Math.max(leftN.y, rightN.y) + CARD_H + 6;
          if (u.children.length) knot(unionPointX, stemTopY, pids, spouseRids);
        }
      } else {
        unionPointX = pnodes[0].cx;
        stemTopY = pnodes[0].y + CARD_H;
      }

      var kids = u.children.map(function (c) { return nodeById.get(c); }).filter(Boolean);
      if (!kids.length) return;

      var childTop = Math.min.apply(null, kids.map(function (k) { return k.top; }));
      var busY0 = childTop - BUS_OFFSET;
      if (busY0 < stemTopY + 14) busY0 = stemTopY + 14;
      var xsAll = kids.map(function (k) { return k.cx; }).concat([unionPointX]);
      busSpecs.push({
        u: u,
        unionPointX: unionPointX,
        stemTopY: stemTopY,
        busY: busY0,
        busY0: busY0,
        busMin: Math.min.apply(null, xsAll),
        busMax: Math.max.apply(null, xsAll),
        kids: kids,
        pids: pids
      });
    });

    // развести «шины» разных союзов одного ряда, если они пересекаются
    var bands = {};
    busSpecs.forEach(function (b) {
      var key = Math.round(b.stemTopY);
      (bands[key] = bands[key] || []).push(b);
    });
    Object.keys(bands).forEach(function (k) {
      var arr = bands[k].sort(function (a, b) { return a.busMin - b.busMin; });
      arr.forEach(function (b, i) {
        var lane = 0;
        for (var j = 0; j < i; j++) {
          var o = arr[j];
          if (!(b.busMax < o.busMin - 1 || b.busMin > o.busMax + 1)) lane = Math.max(lane, o._lane + 1);
        }
        b._lane = lane;
        b.busY = b.busY0 - lane * LANE_STEP;
        if (b.busY < b.stemTopY + 10) b.busY = b.stemTopY + 10;
      });
    });

    busSpecs.forEach(function (b) {
      line(b.unionPointX, b.stemTopY, b.unionPointX, b.busY, '', b.pids);
      line(b.busMin, b.busY, b.busMax, b.busY, '', b.pids.concat(b.u.children));
      b.kids.forEach(function (kid) {
        var cls = childStyle[kid.id] === 'adoptive' ? 'adoptive' : '';
        var rids = parLinks.filter(function (l) {
          return l.sub !== 'step' && l.b === kid.id && b.u.partners.indexOf(l.a) >= 0;
        }).map(function (l) { return l.id; });
        line(kid.cx, b.busY, kid.cx, kid.top, cls, b.pids.concat([kid.id]), rids);
        labelAt(kid.cx + 6, (b.busY + kid.top) / 2, labelOf(rids), rids, 'lbl-parent');
      });
    });

    // отчим / мачеха — пунктирная дуга
    parLinks.forEach(function (l) {
      if (l.sub !== 'step') return;
      var pn = nodeById.get(l.a), cn = nodeById.get(l.b);
      if (!pn || !cn) return;
      var y1 = pn.y + CARD_H, y2 = cn.y;
      quad(pn.cx, y1, (pn.cx + cn.cx) / 2, (y1 + y2) / 2 + 26, cn.cx, y2, 'step', [l.a, l.b], [l.id]);
    });

    // брат / сестра — как обычные дети общего родителя: горизонтальная «шина»
    // с вертикальными спусками, только место родителя пустое (без дуги).
    var hasRealParent = function (id) {
      var ps = parentsOf.get(id) || [];
      for (var i = 0; i < ps.length; i++) if (!hidden.has(ps[i])) return true;
      return false;
    };
    var sibAdj = new Map();
    sibLinks.forEach(function (l) { push(sibAdj, l.a, l.b); push(sibAdj, l.b, l.a); });
    var sibSeen = new Set();
    sibLinks.forEach(function (l) {
      [l.a, l.b].forEach(function (start) {
        if (sibSeen.has(start)) return;
        var group = [], stack = [start];
        sibSeen.add(start);
        while (stack.length) {
          var x = stack.pop();
          group.push(x);
          (sibAdj.get(x) || []).forEach(function (y) { if (!sibSeen.has(y)) { sibSeen.add(y); stack.push(y); } });
        }
        var gnodes = group.map(function (id) { return nodeById.get(id); }).filter(Boolean);
        if (gnodes.length < 2) return;
        var pids = group.slice();

        // если у братьев/сестёр уже есть общий родитель — обычная шина уже есть,
        // оставляем только лёгкую дугу, чтобы не дублировать линию
        if (group.some(hasRealParent)) {
          group.forEach(function (a, i) {
            group.slice(i + 1).forEach(function (b) {
              var link = sibLinks.find(function (z) { return (z.a === a && z.b === b) || (z.a === b && z.b === a); });
              if (!link) return;
              var an = nodeById.get(a), bn = nodeById.get(b);
              if (!an || !bn) return;
              var y = (an.cy + bn.cy) / 2;
              var ax = Math.min(an.cx, bn.cx) + CARD_W / 2, bx = Math.max(an.cx, bn.cx) - CARD_W / 2;
              quad(ax, y, (an.cx + bn.cx) / 2, y - 40, bx, y, 'sibling', [a, b], [link.id]);
              labelAt((an.cx + bn.cx) / 2, y - 44, labelOf([link.id]), [link.id], 'lbl-sibling');
            });
          });
          return;
        }

        gnodes.sort(function (a, b) { return a.cx - b.cx; });
        var top = Math.min.apply(null, gnodes.map(function (k) { return k.top; }));
        var busY = top - BUS_OFFSET;
        var leftX = gnodes[0].cx, rightX = gnodes[gnodes.length - 1].cx;
        var midX = (leftX + rightX) / 2;
        // короткий отросток вверх — пустое место родителя
        line(midX, busY, midX, busY - 22, '', pids);
        // шина и спуски к братьям/сёстрам
        line(leftX, busY, rightX, busY, '', pids);
        gnodes.forEach(function (k) { line(k.cx, busY, k.cx, k.top, '', pids.concat([k.id])); });
        // подписи связей (если заданы)
        sibLinks.forEach(function (link) {
          if (group.indexOf(link.a) < 0 || group.indexOf(link.b) < 0) return;
          var an = nodeById.get(link.a), bn = nodeById.get(link.b);
          if (!an || !bn) return;
          labelAt((an.cx + bn.cx) / 2, busY - 6, labelOf([link.id]), [link.id], 'lbl-sibling');
        });
      });
    });

    // неизвестная / неподтверждённая связь — точечная линия
    unkLinks.forEach(function (l) {
      var an = nodeById.get(l.a), bn = nodeById.get(l.b);
      if (!an || !bn) return;
      line(an.cx, an.cy, bn.cx, bn.cy, 'unknown', [l.a, l.b], [l.id]);
      labelAt((an.cx + bn.cx) / 2, (an.cy + bn.cy) / 2 - 6, labelOf([l.id]), [l.id], 'lbl-unknown');
    });

    // ---- декоративные (свободные) линии ----
    var freeLines = [];
    rawFree.forEach(function (fl, i) {
      if (!fl) return;
      var x1 = Number(fl.x1), y1 = Number(fl.y1), x2 = Number(fl.x2), y2 = Number(fl.y2);
      if (![x1, y1, x2, y2].every(isFinite)) return;
      var line = {
        id: typeof fl.id === 'string' && fl.id ? fl.id : ('fl' + i),
        x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2),
        color: typeof fl.color === 'string' ? fl.color : '',
        width: isFinite(fl.width) ? Math.max(1, Math.min(12, fl.width)) : 2,
        dash: Array.isArray(fl.dash) ? fl.dash.filter(function (n) { return isFinite(n); }).slice(0, 4) : [],
        curve: isFinite(fl.curve) ? fl.curve : 0,
        label: typeof fl.label === 'string' ? fl.label.slice(0, 60) : ''
      };
      freeLines.push(line);
      if (line.label) labelAt((x1 + x2) / 2, (y1 + y2) / 2 - 6, line.label, [], 'lbl-free');
    });

    // ---- границы ----
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.left);
      minY = Math.min(minY, n.top);
      maxX = Math.max(maxX, n.right);
      maxY = Math.max(maxY, n.bottom);
    });
    segments.forEach(function (s) {
      if (s.t === 'c') {
        minX = Math.min(minX, s.x1 - (s.r || 0));
        maxX = Math.max(maxX, s.x1 + (s.r || 0));
        minY = Math.min(minY, s.y1 - (s.r || 0));
        maxY = Math.max(maxY, s.y1 + (s.r || 0));
        return;
      }
      minX = Math.min(minX, s.x1, s.x2);
      maxX = Math.max(maxX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxY = Math.max(maxY, s.y1, s.y2);
    });
    freeLines.forEach(function (l) {
      minX = Math.min(minX, l.x1, l.x2, l.x2 + l.curve);
      maxX = Math.max(maxX, l.x1, l.x2, l.x2 - l.curve);
      minY = Math.min(minY, l.y1, l.y2);
      maxY = Math.max(maxY, l.y1, l.y2);
    });
    labels.forEach(function (t) {
      minX = Math.min(minX, t.x - 40);
      maxX = Math.max(maxX, t.x + 40);
      minY = Math.min(minY, t.y - 12);
      maxY = Math.max(maxY, t.y + 12);
    });

    var maxLvl = 0;
    nodes.forEach(function (n) { maxLvl = Math.max(maxLvl, n.gen); });

    return {
      nodes: nodes,
      segments: segments,
      freeLines: freeLines,
      labels: labels,
      bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY },
      levels: maxLvl + 1,
      groups: comps.length
    };
  }

  function r1(v) { return Math.round(v * 10) / 10; }

  // ============================================================
  // ВИД (pan / zoom / render)
  // ============================================================
  function createView(opts) {
    var canvas = opts.canvas, world = opts.world, svg = opts.svg, nodesEl = opts.nodesEl;
    var onSelect = opts.onSelect || function () {};
    var onCollapse = opts.onCollapse || function () {};

    var state = { x: 0, y: 0, k: 1 };
    var layout = null, byId = new Map(), selSet = new Set(), filterGens = null;
    var pointers = new Map();
    var pan = null, pinch = null, nodeDrag = null, marquee = null, connectDrag = null;
    var suppressClick = false, animTimer = null;
    var marqueeEl = null, previewPath = null;

    function rect() { return canvas.getBoundingClientRect(); }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    function selSetFrom(ids) {
      if (ids instanceof Set) return ids;
      if (Array.isArray(ids)) return new Set(ids);
      return new Set(ids ? [ids] : []);
    }

    function segStyleAttr(st) {
      var parts = [];
      if (st.color) parts.push('stroke:' + st.color);
      if (st.width != null) parts.push('stroke-width:' + st.width);
      if (st.dash && st.dash.length) parts.push('stroke-dasharray:' + st.dash.join(' '));
      return parts.join(';');
    }

    function ensureMarqueeEl() {
      if (!marqueeEl) {
        marqueeEl = document.createElement('div');
        marqueeEl.className = 'marquee';
        marqueeEl.hidden = true;
        canvas.appendChild(marqueeEl);
      }
      return marqueeEl;
    }

    function setPreview(x1, y1, x2, y2) {
      if (!previewPath) {
        previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        previewPath.setAttribute('class', 'preview');
        svg.appendChild(previewPath);
      }
      previewPath.setAttribute('d', 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2);
    }
    function clearPreview() {
      if (previewPath && previewPath.parentNode) previewPath.parentNode.removeChild(previewPath);
      previewPath = null;
    }
    function apply() {
      world.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.k + ')';
    }
    function animate() {
      world.classList.add('anim');
      clearTimeout(animTimer);
      animTimer = setTimeout(function () { world.classList.remove('anim'); }, 460);
    }
    function worldPoint(clientX, clientY, r) {
      r = r || rect();
      return { wx: (clientX - r.left - state.x) / state.k, wy: (clientY - r.top - state.y) / state.k };
    }

    function segPath(s) {
      if (s.t === 'q') return 'M' + s.x1 + ' ' + s.y1 + ' Q' + s.cx + ' ' + s.cy + ' ' + s.x2 + ' ' + s.y2;
      return 'M' + s.x1 + ' ' + s.y1 + ' L' + s.x2 + ' ' + s.y2;
    }

    function genClass(g) { return 'g' + (((g % 6) + 6) % 6); }

    function dimmed(gen) {
      return filterGens && filterGens.size > 0 && !filterGens.has(gen);
    }

    function render() {
      apply();
      if (!layout) {
        svg.innerHTML = '';
        nodesEl.innerHTML = '';
        svg.setAttribute('width', 0);
        svg.setAttribute('height', 0);
        return;
      }

      // Координаты линий — в той же мировой системе, что и карточки (absolute
      // world coords), поэтому слой рёбер НЕ должно дополнительно смещать:
      // иначе при появлении ручных позиций (сдвиг крайней карточки) весь слой
      // линий «уезжает» относительно карточек на (minX, minY).
      svg.setAttribute('width', Math.max(layout.bounds.maxX, 1));
      svg.setAttribute('height', Math.max(layout.bounds.maxY, 1));

      var edgeMarkup = '';
      layout.segments.forEach(function (s) {
        var cls = 'edge' + (s.cls ? ' ' + s.cls : '');
        var dim = true;
        for (var i = 0; i < s.pids.length; i++) {
          var nd = nodeByIdSafe(s.pids[i]);
          if (nd && !dimmed(nd.gen)) { dim = false; break; }
        }
        if (dim && filterGens && filterGens.size > 0) cls += ' dim';
        var st = s.st ? ' style="' + segStyleAttr(s.st) + '"' : '';
        if (s.t === 'c') {
          edgeMarkup += '<circle class="' + cls + '" cx="' + s.x1 + '" cy="' + s.y1 + '" r="' + (s.r || KNOT_R) + '"' + st + '/>';
        } else {
          edgeMarkup += '<path class="' + cls + '" d="' + segPath(s) + '"' + st + '/>';
        }
      });

      // свободные (декоративные) линии
      (layout.freeLines || []).forEach(function (l) {
        var d = l.curve
          ? ('M' + l.x1 + ' ' + l.y1 + ' Q' + ((l.x1 + l.x2) / 2 + l.curve) + ' ' + ((l.y1 + l.y2) / 2) + ' ' + l.x2 + ' ' + l.y2)
          : ('M' + l.x1 + ' ' + l.y1 + ' L' + l.x2 + ' ' + l.y2);
        var st = 'fill:none;stroke:' + (l.color || 'var(--acc)') + ';stroke-width:' + (l.width || 2) +
          (l.dash && l.dash.length ? ';stroke-dasharray:' + l.dash.join(' ') : '');
        edgeMarkup += '<path class="fline" data-fline="' + escapeHtml(l.id) + '" d="' + d + '" style="' + st + '"/>';
      });

      // подписи линий
      (layout.labels || []).forEach(function (t) {
        edgeMarkup += '<text class="elabel' + (t.cls ? ' ' + t.cls : '') + '" x="' + t.x + '" y="' + t.y + '">' + escapeHtml(t.text) + '</text>';
      });
      svg.innerHTML = edgeMarkup;
      if (previewPath) svg.appendChild(previewPath);

      var html = '';
      layout.nodes.forEach(function (n) {
        var p = byId.get(n.id);
        var cls = ['tnode', genClass(n.gen)];
        if (selSet.has(n.id)) cls.push('sel');
        if (dimmed(n.gen)) cls.push('dim');
        var nameCls = 'tn-name' + (isUnnamed(p) ? ' unnamed' : '');
        var sub = personYears(p) || (p && p.profession ? p.profession : '');
        var toggle = '';
        if (n.hasChildren) {
          toggle = '<button class="tn-collapse' + (n.collapsed ? ' collapsed' : '') +
            '" data-collapse="' + escapeHtml(n.id) + '" title="' +
            (n.collapsed ? 'Показать ветвь' : 'Свернуть ветвь') + '">' +
            (n.collapsed ? '+' + (n.hiddenDesc || '') : '\u25be') + '</button>';
        }
        html += '<div class="' + cls.join(' ') + '" data-id="' + escapeHtml(n.id) + '"' +
          ' style="transform:translate(' + n.left + 'px,' + n.top + 'px)">' +
          avatarHtml(p, 'tn-ava') +
          '<div class="tn-txt">' +
          '<div class="' + nameCls + '">' + escapeHtml(personName(p)) + '</div>' +
          '<div class="tn-sub">' + escapeHtml(sub) + '</div>' +
          '</div>' + toggle + '</div>';
      });
      nodesEl.innerHTML = html;
    }

    function nodeByIdSafe(id) {
      if (!layout) return null;
      if (!nodeIndex) nodeIndex = new Map();
      return nodeIndex.get(id) || null;
    }
    // индекс узлов пересоздаётся при setModel
    var nodeIndex = new Map();

    function setModel(l, ctx) {
      layout = l;
      byId = ctx.byId;
      selSet = selSetFrom(ctx.selectedIds != null ? ctx.selectedIds : ctx.selectedId);
      filterGens = ctx.filterGens || null;
      nodeIndex = new Map();
      (l.nodes || []).forEach(function (n) { nodeIndex.set(n.id, n); });
      render();
    }

    function setSelection(ids) {
      selSet = selSetFrom(ids);
      if (!layout) return;
      var nodes = nodesEl.children;
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.toggle('sel', selSet.has(nodes[i].getAttribute('data-id')));
      }
    }

    function setTool(name) {
      canvas.classList.remove('tool-move', 'tool-select', 'tool-connect', 'tool-line');
      canvas.classList.add('tool-' + (name || 'move'));
    }

    function setFilter(f) { filterGens = f; render(); }

    function fit(doAnimate) {
      var r = rect();
      if (!layout || !layout.nodes.length) {
        state = { x: 0, y: 0, k: 1 };
        if (doAnimate) animate();
        apply();
        return;
      }
      var b = layout.bounds;
      var pad = 64;
      var bw = Math.max(b.w, 1), bh = Math.max(b.h, 1);
      var k = clamp(Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh), FIT_MIN_K, 1.3);
      state.k = k;
      state.x = (r.width - bw * k) / 2 - b.minX * k;
      state.y = (r.height - bh * k) / 2 - b.minY * k;
      if (doAnimate) animate();
      apply();
    }

    function centerOn(id, doAnimate) {
      if (!layout) return;
      var n = nodeIndex.get(id);
      if (!n) return;
      var r = rect();
      if (state.k < 0.6) state.k = 0.9;
      state.x = r.width / 2 - n.cx * state.k;
      state.y = r.height / 2 - n.cy * state.k;
      if (doAnimate) animate();
      apply();
    }

    // Центрирует всё дерево в видимой области, НЕ меняя масштаб.
    // (в отличие от fit(), который подбирает масштаб под размер экрана)
    function centerBounds(doAnimate) {
      if (!layout || !layout.nodes.length) {
        state.x = 0; state.y = 0;
        if (doAnimate) animate();
        apply();
        return;
      }
      var r = rect();
      var b = layout.bounds;
      var cxw = (b.minX + b.maxX) / 2;
      var cyw = (b.minY + b.maxY) / 2;
      state.x = r.width / 2 - cxw * state.k;
      state.y = r.height / 2 - cyw * state.k;
      if (doAnimate) animate();
      apply();
    }

    function zoomBy(factor, doAnimate) {
      var r = rect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, doAnimate);
    }

    function zoomAt(clientX, clientY, factor, doAnimate) {
      var r = rect();
      var wpt = worldPoint(clientX, clientY, r);
      var k = clamp(state.k * factor, MIN_K, MAX_K);
      state.x = clientX - r.left - wpt.wx * k;
      state.y = clientY - r.top - wpt.wy * k;
      state.k = k;
      if (doAnimate) animate();
      apply();
    }

    function getTransform() { return { x: state.x, y: state.y, k: state.k }; }

    // ---------------- указатель ----------------
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function midPt(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

    function getTool() { return (opts.getTool && opts.getTool()) || 'move'; }

    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        pan = null; nodeDrag = null; marquee = null; connectDrag = null;
        var pts = Array.from(pointers.values());
        pinch = {
          d0: dist(pts[0], pts[1]),
          k0: state.k,
          w0: worldPoint(midPt(pts[0], pts[1]).x, midPt(pts[0], pts[1]).y)
        };
        canvas.classList.add('grabbing');
        return;
      }
      if (pointers.size !== 1) return;
      if (e.target.closest && (e.target.closest('.tools') || e.target.closest('.zoom-fab') ||
        e.target.closest('.empty-state') || e.target.closest('.details') || e.target.closest('.tool-hint'))) {
        return;
      }
      world.classList.remove('anim');

      var tool = getTool();
      var nodeEl = e.target.closest ? e.target.closest('.tnode') : null;
      var colEl = e.target.closest ? e.target.closest('.tn-collapse') : null;
      var wp = worldPoint(e.clientX, e.clientY);

      if (tool === 'connect') {
        if (nodeEl && !colEl) {
          connectDrag = { id: nodeEl.getAttribute('data-id'), moved: false, sx: e.clientX, sy: e.clientY };
          if (opts.onConnectStart) opts.onConnectStart(connectDrag.id);
        }
        return;
      }
      if (tool === 'line') return;
      if (tool === 'select') {
        marquee = { sx: e.clientX, sy: e.clientY, wx: wp.wx, wy: wp.wy, moved: false };
        return;
      }
      // move tool
      if (nodeEl && !colEl) {
        nodeDrag = { id: nodeEl.getAttribute('data-id'), sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
      pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.x, oy: state.y, moved: false };
    });

    window.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pinch && pointers.size >= 2) {
        var pts = Array.from(pointers.values());
        var d = Math.max(dist(pts[0], pts[1]), 1);
        var m = midPt(pts[0], pts[1]);
        var r = rect();
        var k = clamp(pinch.k0 * (d / pinch.d0), MIN_K, MAX_K);
        state.k = k;
        state.x = m.x - r.left - pinch.w0.wx * k;
        state.y = m.y - r.top - pinch.w0.wy * k;
        apply();
        return;
      }

      if (pan && pan.id === e.pointerId) {
        var dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
        if (!pan.moved && Math.hypot(dx, dy) > 4) {
          pan.moved = true;
          canvas.classList.add('grabbing');
        }
        if (pan.moved) {
          suppressClick = true;
          state.x = pan.ox + dx;
          state.y = pan.oy + dy;
          apply();
        }
        return;
      }

      if (nodeDrag) {
        var dxc = e.clientX - nodeDrag.sx, dyc = e.clientY - nodeDrag.sy;
        if (!nodeDrag.moved && Math.abs(dxc) + Math.abs(dyc) > 4) {
          nodeDrag.moved = true;
          suppressClick = true;
          nodesEl.classList.add('dragging-mode');
          if (opts.onNodeDragStart) opts.onNodeDragStart(nodeDrag.id);
        }
        if (nodeDrag.moved && opts.onNodeDragMove) opts.onNodeDragMove(dxc / state.k, dyc / state.k);
        return;
      }

      if (marquee) {
        marquee.moved = true;
        suppressClick = true;
        var r2 = rect();
        var x1 = Math.min(marquee.sx, e.clientX) - r2.left;
        var x2 = Math.max(marquee.sx, e.clientX) - r2.left;
        var y1 = Math.min(marquee.sy, e.clientY) - r2.top;
        var y2 = Math.max(marquee.sy, e.clientY) - r2.top;
        var el = ensureMarqueeEl();
        el.hidden = false;
        el.style.left = x1 + 'px';
        el.style.top = y1 + 'px';
        el.style.width = (x2 - x1) + 'px';
        el.style.height = (y2 - y1) + 'px';
        var wpM = worldPoint(e.clientX, e.clientY);
        if (opts.onMarqueeUpdate) opts.onMarqueeUpdate(marquee.wx, marquee.wy, wpM.wx, wpM.wy);
        return;
      }

      if (connectDrag) {
        connectDrag.moved = true;
        suppressClick = true;
        var wpC = worldPoint(e.clientX, e.clientY);
        var src = nodeIndex.get(connectDrag.id);
        if (src) setPreview(src.cx, src.cy, wpC.wx, wpC.wy);
        if (opts.onConnectMove) opts.onConnectMove(connectDrag.id, wpC.wx, wpC.wy);
        return;
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pan && pan.id === e.pointerId) { pan = null; canvas.classList.remove('grabbing'); }
      if (nodeDrag) {
        var movedN = nodeDrag.moved;
        nodeDrag = null;
        nodesEl.classList.remove('dragging-mode');
        if (movedN && opts.onNodeDragEnd) opts.onNodeDragEnd();
      }
      if (marquee) {
        var mq = marquee;
        marquee = null;
        if (marqueeEl) marqueeEl.hidden = true;
        var wpE = worldPoint(e.clientX, e.clientY);
        if (opts.onMarqueeEnd) opts.onMarqueeEnd(mq.wx, mq.wy, wpE.wx, wpE.wy, mq.moved);
      }
      if (connectDrag) {
        var cd = connectDrag;
        connectDrag = null;
        clearPreview();
        var toId = null;
        try {
          var hitEl = document.elementFromPoint(e.clientX, e.clientY);
          var hitNode = hitEl && hitEl.closest ? hitEl.closest('.tnode') : null;
          if (hitNode) toId = hitNode.getAttribute('data-id');
        } catch (err) { /* ignore */ }
        if (opts.onConnectEnd) opts.onConnectEnd(cd.id, toId, cd.moved);
      }
    }
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    window.addEventListener('blur', function () {
      pointers.clear(); pan = null; pinch = null; nodeDrag = null; marquee = null; connectDrag = null;
      clearPreview();
      if (marqueeEl) marqueeEl.hidden = true;
      canvas.classList.remove('grabbing');
    });

    // наведение (для предпросмотра свободной линии), когда кнопка не нажата
    canvas.addEventListener('pointermove', function (e) {
      if (pointers.size) return;
      if (opts.onHover) {
        var wpH = worldPoint(e.clientX, e.clientY);
        opts.onHover(wpH.wx, wpH.wy);
      }
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016), false);
    }, { passive: false });

    canvas.addEventListener('dblclick', function (e) {
      if (e.target.closest && (e.target.closest('.tnode') || e.target.closest('.zoom-fab') || e.target.closest('.empty-state'))) return;
      zoomAt(e.clientX, e.clientY, 1.35, true);
    });

    canvas.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.zoom-fab')) return;
      if (e.target.closest && e.target.closest('.empty-state')) return;
      if (e.target.closest && e.target.closest('.details')) return;
      if (e.target.closest && e.target.closest('.tools')) return;
      if (suppressClick) { suppressClick = false; return; }
      var tool = getTool();
      var wp = worldPoint(e.clientX, e.clientY);
      if (tool === 'line') { if (opts.onLineClick) opts.onLineClick(wp.wx, wp.wy); return; }
      var col = e.target.closest ? e.target.closest('.tn-collapse') : null;
      if (col) { onCollapse(col.getAttribute('data-collapse')); return; }
      var nc = e.target.closest ? e.target.closest('.tnode') : null;
      if (nc) { onSelect(nc.getAttribute('data-id'), { additive: !!(e.shiftKey || e.ctrlKey || e.metaKey) }); return; }
      if (opts.onCanvasClick) opts.onCanvasClick(wp.wx, wp.wy, e);
      else onSelect(null);
    });

    return {
      setModel: setModel,
      setSelection: setSelection,
      setFilter: setFilter,
      setTool: setTool,
      setPreview: setPreview,
      clearPreview: clearPreview,
      render: render,
      fit: fit,
      centerOn: centerOn,
      centerBounds: centerBounds,
      zoomBy: zoomBy,
      getTransform: getTransform,
      _nodeIndex: function () { return nodeIndex; }
    };
  }

  // ============================================================
  // ЭКСПОРТ В PNG
  // ============================================================
  function cssColors() {
    var cs = getComputedStyle(document.documentElement);
    function g(n) { return cs.getPropertyValue(n).trim(); }
    return {
      bg: g('--bg-soft') || '#f4f7f5',
      nodeBg: g('--node-bg') || '#ffffff',
      nodeLine: g('--line') || '#dbe3de',
      txt: g('--txt') || '#1e2a24',
      dim: g('--dim') || '#5f7168',
      acc: g('--acc') || '#2e8b64',
      edge: g('--edge') || '#9db0a6',
      edgeAdopt: g('--edge-adopt') || '#b49a64',
      spouse: g('--spouse') || '#c08a7a',
      gen: GEN_VARS.map(function (v) { return g(v); })
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function loadImage(src) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = src;
    });
  }

  function truncate(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '\u2026').width > maxW) t = t.slice(0, -1);
    return t + '\u2026';
  }

  async function exportPNG(layout, byId, opts) {
    opts = opts || {};
    var scale = opts.scale || 2;
    var pad = 48;
    var colors = opts.colors || cssColors();
    var b = layout.bounds;
    var w = Math.max(1, b.w + pad * 2);
    var h = Math.max(1, b.h + pad * 2);

    // предзагрузка фото
    var photoSrcs = [];
    layout.nodes.forEach(function (n) {
      var p = byId.get(n.id);
      if (p && p.photo) photoSrcs.push(p.photo);
    });
    var images = new Map();
    await Promise.all(photoSrcs.map(function (s) {
      return loadImage(s).then(function (img) { images.set(s, img); });
    }));

    var cv = document.createElement('canvas');
    cv.width = Math.round(w * scale);
    cv.height = Math.round(h * scale);
    var ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.translate(pad - b.minX, pad - b.minY);

    ctx.fillStyle = colors.bg;
    ctx.fillRect(b.minX - pad, b.minY - pad, w, h);

    // рёбра
    layout.segments.forEach(function (s) {
      var st = s.st;
      if (s.t === 'c') {
        ctx.beginPath();
        ctx.arc(s.x1, s.y1, s.r || KNOT_R, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = (st && st.color) ? st.color : colors.edge;
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      if (s.t === 'q') ctx.quadraticCurveTo(s.cx, s.cy, s.x2, s.y2);
      else ctx.lineTo(s.x2, s.y2);
      ctx.lineCap = 'round';
      if (st) {
        ctx.lineWidth = st.width != null ? st.width : 2;
        ctx.setLineDash(st.dash && st.dash.length ? st.dash : []);
        ctx.strokeStyle = st.color || colors.edge;
      } else {
        ctx.lineWidth = s.cls === 'spouse' ? 2.5 : (s.cls === 'partner' ? 2 : 2);
        if (s.cls === 'adoptive') { ctx.setLineDash([6, 5]); ctx.strokeStyle = colors.edgeAdopt; }
        else if (s.cls === 'step') { ctx.setLineDash([4, 5]); ctx.strokeStyle = colors.edgeAdopt; }
        else if (s.cls === 'spouse') { ctx.setLineDash([]); ctx.strokeStyle = colors.spouse; }
        else if (s.cls === 'partner') { ctx.setLineDash([2, 5]); ctx.strokeStyle = colors.spouse; }
        else if (s.cls === 'sibling') { ctx.setLineDash([7, 5]); ctx.strokeStyle = colors.edge; }
        else if (s.cls === 'unknown') { ctx.setLineDash([2, 6]); ctx.strokeStyle = colors.dim; }
        else { ctx.setLineDash([]); ctx.strokeStyle = colors.edge; }
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // свободные (декоративные) линии
    (layout.freeLines || []).forEach(function (l) {
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      if (l.curve) ctx.quadraticCurveTo((l.x1 + l.x2) / 2 + l.curve, (l.y1 + l.y2) / 2, l.x2, l.y2);
      else ctx.lineTo(l.x2, l.y2);
      ctx.lineWidth = l.width || 2;
      ctx.setLineDash(l.dash && l.dash.length ? l.dash : []);
      ctx.strokeStyle = l.color || colors.acc;
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // подписи линий
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    (layout.labels || []).forEach(function (t) {
      ctx.font = '600 11px "Segoe UI", Arial, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(t.text, t.x, t.y - 2);
      ctx.fillStyle = colors.dim;
      ctx.fillText(t.text, t.x, t.y - 2);
    });

    // карточки
    layout.nodes.forEach(function (n) {
      var p = byId.get(n.id) || {};
      var gen = colors.gen[n.gen % colors.gen.length] || colors.acc;

      ctx.save();
      ctx.shadowColor = 'rgba(24,40,32,0.14)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      roundRect(ctx, n.left, n.top, CARD_W, CARD_H, 12);
      ctx.fillStyle = colors.nodeBg;
      ctx.fill();
      ctx.restore();

      roundRect(ctx, n.left, n.top, CARD_W, CARD_H, 12);
      ctx.strokeStyle = colors.nodeLine;
      ctx.lineWidth = 1;
      ctx.stroke();

      // полоса поколения
      roundRect(ctx, n.left, n.top + 8, 4, CARD_H - 16, 3);
      ctx.fillStyle = gen;
      ctx.fill();

      // аватар
      var ax = n.left + 16, ay = n.top + 12, as = 40;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ax + as / 2, ay + as / 2, as / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = colors.nodeBg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = gen;
      ctx.stroke();
      ctx.clip();
      var img = p.photo ? images.get(p.photo) : null;
      if (img) {
        ctx.drawImage(img, ax, ay, as, as);
      } else {
        ctx.fillStyle = gen;
        ctx.font = '700 15px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials(p), ax + as / 2, ay + as / 2 + 1);
      }
      ctx.restore();

      // текст
      var tx = n.left + 66;
      var maxW = CARD_W - 66 - 12;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = colors.txt;
      ctx.font = '600 13px "Segoe UI", Arial, sans-serif';
      ctx.fillText(truncate(ctx, personName(p), maxW), tx, n.top + 28);
      var sub = personYears(p) || (p.profession || '');
      if (sub) {
        ctx.fillStyle = colors.dim;
        ctx.font = '400 11.5px "Segoe UI", Arial, sans-serif';
        ctx.fillText(truncate(ctx, sub, maxW), tx, n.top + 46);
      }
    });

    return new Promise(function (res) {
      cv.toBlob(function (blob) { res(blob); }, 'image/png');
    });
  }

  return {
    CARD_W: CARD_W,
    CARD_H: CARD_H,
    computeLayout: computeLayout,
    createView: createView,
    exportPNG: exportPNG,
    cssColors: cssColors,
    personName: personName,
    personYears: personYears,
    initials: initials,
    isUnnamed: isUnnamed,
    yearOf: yearOf,
    escapeHtml: escapeHtml,
    avatarHtml: avatarHtml
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FT;
} else if (typeof window !== 'undefined') {
  window.FT = FT;
}
