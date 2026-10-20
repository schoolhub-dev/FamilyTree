/* ============================================================
   Семейное древо — совместная работа (Supabase)
   - анонимный вход (без почты и пароля);
   - одно общее древо на пользователя;
   - приглашение по коду, роли: owner / editor / viewer;
   - сохранение слиянием изменений (без потери правок);
   - Realtime-обновления между устройствами.

   Если облако не настроено (cloud-config.js или настройки в
   браузере пусты), приложение продолжает работать локально.
   ============================================================ */
(function (root) {
  'use strict';

  var CONFIG_KEY = 'familyTree.cloud.config.v1';
  var PROFILE_KEY = 'familyTree.profile.v1';
  var MAX_MERGE_RETRIES = 4;

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  function fileConfig() {
    return (root && root.FAMILY_TREE_CLOUD) || {};
  }
  function config() {
    var saved = readJSON(CONFIG_KEY) || {};
    var base = fileConfig();
    return {
      url: String(saved.url || base.url || '').replace(/\/+$/, ''),
      anonKey: String(saved.anonKey || base.anonKey || '')
    };
  }
  function isConfigured() {
    var c = config();
    return !!(c.url && c.anonKey);
  }
  function libReady() {
    return !!(root && root.supabase && root.supabase.createClient);
  }

  var profile = readJSON(PROFILE_KEY) || {};
  function profileName() {
    return String(profile.name || '').trim() || 'Гость';
  }
  function setProfileName(name) {
    profile.name = String(name || '').trim().slice(0, 60);
    writeJSON(PROFILE_KEY, profile);
    return profileName();
  }

  // ---------- состояние ----------
  var client = null;
  var user = null;
  var tree = null;
  var role = null;
  var members = [];
  var channel = null;
  var baseRevision = 0;
  var knownBase = null;
  var lastSignature = null;
  var pendingStr = null;
  var dirty = false;
  var saving = false;
  var mergeRetries = 0;
  var saveTimer = null;
  var retryTimer = null;
  var retryDelay = 2000;
  var queuedRemote = null;
  var status = 'off';
  var statusText = 'Облако не подключено';
  var handlers = {};

  function blank() {
    return { version: 2, people: [], relations: [], positions: {}, freeLines: [], appearance: { relations: {} } };
  }
  function errText(e) {
    var m = e && (e.message || e.error_description || e.details || e.hint);
    return String(m || e || 'Неизвестная ошибка');
  }
  function emitStatus(s, t) {
    status = s;
    statusText = t || '';
    if (handlers.onStatus) { try { handlers.onStatus(); } catch (e) { /* ignore */ } }
  }
  function emitData(data, meta) {
    if (handlers.onData) { try { handlers.onData(data, meta || {}); } catch (e) { /* ignore */ } }
  }
  function emitTree() {
    if (handlers.onTree) { try { handlers.onTree(); } catch (e) { /* ignore */ } }
  }

  // ---------- слияние изменений ----------
  function canon(v) {
    if (v === undefined) return 'undefined';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  function eq(a, b) { return canon(a) === canon(b); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  function byId(list) {
    var m = {};
    (Array.isArray(list) ? list : []).forEach(function (it) {
      if (it && it.id != null) m[it.id] = it;
    });
    return m;
  }

  function mergeItem(b, l, r) {
    if (!l) return r;
    if (!r) return l;
    if (eq(l, r)) return l;
    if (b && eq(l, b)) return r;
    if (b && eq(r, b)) return l;
    var keys = {};
    [b, l, r].forEach(function (o) {
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { keys[k] = 1; });
    });
    var out = {};
    Object.keys(keys).forEach(function (k) {
      var lHas = has(l, k), rHas = has(r, k), bHas = has(b, k);
      var lv = l[k], rv = r[k], bv = b ? b[k] : undefined;
      if (!lHas) { out[k] = rv; return; }
      if (!rHas) { out[k] = lv; return; }
      if (eq(lv, rv)) { out[k] = lv; return; }
      if (bHas && eq(lv, bv)) { out[k] = rv; return; }
      if (bHas && eq(rv, bv)) { out[k] = lv; return; }
      out[k] = lv; // обе стороны изменили поле — приоритет у локальной правки
    });
    return out;
  }

  function mergeList(base, local, remote) {
    var bm = byId(base), lm = byId(local), rm = byId(remote);
    var out = [], seen = {};
    function push(it) {
      if (!it || it.id == null || seen[it.id]) return;
      seen[it.id] = 1;
      out.push(it);
    }
    (Array.isArray(local) ? local : []).forEach(function (item) {
      if (!item || item.id == null) { push(item); return; }
      var id = item.id, b = bm[id], r = rm[id];
      if (r) push(mergeItem(b, item, r));
      else if (!b) push(item);                       // добавлено локально
      else if (eq(item, b)) { /* удалено на сервере, локально не менялось */ }
      else push(mergeItem(b, item, r));              // удалено на сервере, но изменено локально
    });
    (Array.isArray(remote) ? remote : []).forEach(function (item) {
      if (!item || item.id == null) return;
      var id = item.id;
      if (seen[id]) return;
      if (lm[id]) return;
      var b = bm[id];
      if (!b) push(item);                            // добавлено на сервере
      else if (!eq(item, b)) push(item);             // удалено локально, но изменено на сервере
    });
    return out;
  }

  function mergeMap(base, local, remote) {
    var b = base || {}, l = local || {}, r = remote || {};
    var keys = {};
    [b, l, r].forEach(function (o) {
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { keys[k] = 1; });
    });
    var out = {};
    Object.keys(keys).forEach(function (k) {
      var lHas = has(l, k), rHas = has(r, k), bHas = has(b, k);
      var lv = l[k], rv = r[k], bv = b[k];
      if (lHas && rHas) {
        if (eq(lv, rv)) out[k] = lv;
        else if (bHas && eq(lv, bv)) out[k] = rv;
        else if (bHas && eq(rv, bv)) out[k] = lv;
        else out[k] = lv;
      } else if (lHas && !rHas) {
        if (!bHas) out[k] = lv;
        else if (!eq(lv, bv)) out[k] = lv;
      } else if (!lHas && rHas) {
        if (!bHas) out[k] = rv;
        else if (!eq(rv, bv)) out[k] = rv;
      }
    });
    return out;
  }

  function mergeAppearance(b, l, r) {
    b = b || {}; l = l || {}; r = r || {};
    var out = {};
    out.relations = mergeMap(b.relations, l.relations, r.relations);
    var keys = {};
    [b, l, r].forEach(function (o) {
      Object.keys(o || {}).forEach(function (k) { if (k !== 'relations') keys[k] = 1; });
    });
    Object.keys(keys).forEach(function (k) {
      out[k] = mergeItem({ v: b[k] }, { v: l[k] }, { v: r[k] }).v;
    });
    return out;
  }

  function mergeData(base, local, remote) {
    base = base || blank();
    local = local || blank();
    remote = remote || blank();
    return {
      version: remote.version || local.version || base.version || 2,
      people: mergeList(base.people, local.people, remote.people),
      relations: mergeList(base.relations, local.relations, remote.relations),
      positions: mergeMap(base.positions, local.positions, remote.positions),
      freeLines: mergeList(base.freeLines, local.freeLines, remote.freeLines),
      appearance: mergeAppearance(base.appearance, local.appearance, remote.appearance)
    };
  }

  function contentSig(data) {
    data = data || blank();
    return canon({
      people: data.people || [],
      relations: data.relations || [],
      freeLines: data.freeLines || [],
      appearance: data.appearance || {}
    });
  }

  // ---------- служебное ----------
  function authorOf(uid) {
    if (uid && user && uid === user.id) return profileName();
    for (var i = 0; i < members.length; i++) {
      if (members[i].user_id === uid) return members[i].display_name || 'Соавтор';
    }
    return 'Соавтор';
  }
  function isActive() { return !!tree; }
  function canEdit() {
    if (!tree) return true;
    return role === 'owner' || role === 'editor';
  }

  function subscribe() {
    if (channel && client) {
      try { client.removeChannel(channel); } catch (e) { /* ignore */ }
      channel = null;
    }
    if (!client || !tree) return;
    channel = client.channel('ft-' + tree.id)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'trees', filter: 'id=eq.' + tree.id
      }, function (payload) { if (payload && payload.new) handleRemote(payload.new); })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'tree_members', filter: 'tree_id=eq.' + tree.id
      }, function () { refreshMembers(); })
      .subscribe();
  }

  function adopt(t, r) {
    if (!t) return;
    tree = t;
    role = r || 'editor';
    baseRevision = Number(t.revision) || 0;
    knownBase = t.data || blank();
    lastSignature = contentSig(knownBase);
    dirty = false;
    pendingStr = null;
    saving = false;
    queuedRemote = null;
    mergeRetries = 0;
    retryDelay = 2000;
    clearTimeout(retryTimer);
    clearTimeout(saveTimer);
    subscribe();
    refreshMembers();
    emitStatus('ready', 'Синхронизировано');
    emitTree();
    emitData(knownBase, { initial: true });
  }

  function syncRoleFromMembers() {
    if (!user) return;
    var self = null;
    for (var i = 0; i < members.length; i++) {
      if (members[i].user_id === user.id) { self = members[i]; break; }
    }
    if (self) role = self.role;
    else if (members.length) role = null;
    if (role === null) emitStatus('readonly', 'Доступ к общему древу закрыт');
  }

  function refreshMembers() {
    if (!client || !tree) return;
    client.rpc('ft_list_members', { p_tree: tree.id }).then(function (res) {
      if (!res.error && Array.isArray(res.data)) {
        members = res.data;
        syncRoleFromMembers();
        if (handlers.onMembers) { try { handlers.onMembers(); } catch (e) { /* ignore */ } }
        emitStatus(status, statusText);
      }
    }, function () { /* нет связи — не критично */ });
  }

  function handleRemote(row) {
    if (!tree || !row || row.id !== tree.id) return;
    var rev = Number(row.revision) || 0;
    if (saving) {
      if (rev > baseRevision) queuedRemote = row;
      return;
    }
    if (row.updated_by === user.id && rev <= baseRevision) return;
    if (rev <= baseRevision) return;

    var remoteData = row.data || blank();
    var author = authorOf(row.updated_by);

    if (dirty && pendingStr) {
      var localNow;
      try { localNow = JSON.parse(pendingStr); } catch (e) { localNow = remoteData; }
      var merged = mergeData(knownBase || blank(), localNow, remoteData);
      pendingStr = JSON.stringify(merged);
      knownBase = remoteData;
      baseRevision = rev;
      lastSignature = contentSig(remoteData);
      tree = Object.assign({}, tree, { revision: rev, data: remoteData });
      emitStatus('saving', 'Слияние изменений…');
      emitData(merged, { merged: true, author: author });
      flush();
    } else {
      knownBase = remoteData;
      baseRevision = rev;
      lastSignature = contentSig(remoteData);
      tree = Object.assign({}, tree, { revision: rev, data: remoteData });
      emitStatus('saved', 'Синхронизировано');
      emitData(remoteData, { remote: true, author: author });
    }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryDelay = Math.min(Math.round(retryDelay * 1.6), 15000);
      flush();
    }, retryDelay);
  }

  async function flush() {
    if (!isActive() || !canEdit() || saving) return;
    if (!dirty || !pendingStr) return;
    if (!client) return;

    var payloadStr = pendingStr;
    var payload;
    try { payload = JSON.parse(payloadStr); } catch (e) { return; }

    var snap = contentSig(payload) !== lastSignature;
    saving = true;
    emitStatus('saving', 'Сохранение…');

    try {
      var res = await client.rpc('ft_save_tree', {
        p_tree: tree.id,
        p_data: payload,
        p_base_revision: baseRevision,
        p_author_name: profileName(),
        p_snapshot: snap
      });
      if (res.error) throw new Error(res.error.message);
      var out = res.data || {};

      if (out.conflict && out.tree) {
        mergeRetries++;
        var remote = out.tree;
        var localNow;
        try { localNow = JSON.parse(pendingStr || payloadStr); } catch (e) { localNow = payload; }
        var merged = mergeData(knownBase || blank(), localNow, remote.data || blank());
        pendingStr = JSON.stringify(merged);
        dirty = true;
        knownBase = remote.data || blank();
        baseRevision = Number(remote.revision) || baseRevision + 1;
        lastSignature = contentSig(knownBase);
        tree = remote;
        saving = false;
        emitStatus('saving', 'Слияние изменений…');
        emitData(merged, { merged: true, author: authorOf(remote.updated_by) });
        if (mergeRetries > MAX_MERGE_RETRIES) {
          mergeRetries = 0;
          emitStatus('error', 'Не удалось согласовать изменения');
          return;
        }
        setTimeout(flush, 40);
        return;
      }

      mergeRetries = 0;
      retryDelay = 2000;
      baseRevision = Number(out.revision) || baseRevision + 1;
      knownBase = payload;
      if (snap) lastSignature = contentSig(payload);
      tree = Object.assign({}, tree, { revision: baseRevision, data: payload });
      dirty = !!pendingStr && pendingStr !== payloadStr;
      if (!dirty) pendingStr = null;
      saving = false;
      emitStatus('saved', 'Синхронизировано');
      emitTree();
      if (dirty) { setTimeout(flush, 60); }
      else if (queuedRemote) {
        var q = queuedRemote;
        queuedRemote = null;
        handleRemote(q);
      }
    } catch (e) {
      saving = false;
      var msg = String((e && e.message) || e || '');
      if (/Нет прав|Нет доступа|permission denied/i.test(msg)) {
        emitStatus('readonly', msg);
        return;
      }
      emitStatus('offline', 'Нет связи — изменения сохранены на устройстве');
      scheduleRetry();
    }
  }

  // ---------- публичный API ----------
  async function init(h) {
    handlers = h || {};
    if (!isConfigured()) {
      emitStatus('off', 'Облако не подключено');
      return false;
    }
    if (!libReady()) {
      emitStatus('error', 'Не загрузилась библиотека Supabase');
      return false;
    }
    emitStatus('connecting', 'Подключение…');
    try {
      var cfg = config();
      client = root.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      var sres = await client.auth.getSession();
      var session = sres && sres.data ? sres.data.session : null;
      if (!session) {
        var ares = await client.auth.signInAnonymously();
        if (ares.error) {
          throw new Error(ares.error.message + '. Включите Anonymous sign-ins в Supabase → Authentication → Sign In / Providers.');
        }
        user = ares.data.user;
      } else {
        user = session.user;
      }
      if (!user) throw new Error('Не удалось создать сессию');

      var r = await client.rpc('ft_my_tree');
      if (r.error) throw new Error(r.error.message);
      if (r.data && r.data.tree) {
        adopt(r.data.tree, r.data.role);
      } else {
        tree = null;
        role = null;
        emitStatus('ready', 'Облако подключено');
        emitTree();
      }
      return true;
    } catch (e) {
      emitStatus('error', errText(e));
      return false;
    }
  }

  function save(data) {
    if (!isActive() || !canEdit()) return;
    pendingStr = JSON.stringify(data);
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }

  function retry() {
    clearTimeout(retryTimer);
    retryDelay = 2000;
    flush();
  }

  async function createTree(name, data) {
    if (!client) throw new Error('Облако не подключено');
    var res = await client.rpc('ft_create_tree', {
      p_name: name || '',
      p_data: data || blank(),
      p_display_name: profileName()
    });
    if (res.error) throw new Error(res.error.message);
    adopt(res.data.tree, res.data.role || 'owner');
    return res.data;
  }

  async function joinTree(code) {
    if (!client) throw new Error('Облако не подключено');
    var res = await client.rpc('ft_join_tree', {
      p_code: String(code || '').trim(),
      p_display_name: profileName()
    });
    if (res.error) throw new Error(res.error.message);
    adopt(res.data.tree, res.data.role || 'editor');
    return res.data;
  }

  async function listVersions() {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_list_versions', { p_tree: tree.id });
    if (res.error) throw new Error(res.error.message);
    return Array.isArray(res.data) ? res.data : [];
  }

  async function restoreVersion(id) {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_restore_version', {
      p_version: Number(id),
      p_author_name: profileName()
    });
    if (res.error) throw new Error(res.error.message);
    var t = res.data && res.data.tree;
    if (!t) throw new Error('Сервер не вернул версию');
    knownBase = t.data || blank();
    baseRevision = Number(t.revision) || baseRevision + 1;
    lastSignature = contentSig(knownBase);
    tree = t;
    dirty = false;
    pendingStr = null;
    emitStatus('saved', 'Версия восстановлена');
    emitTree();
    emitData(knownBase, { restored: true });
    return t;
  }

  async function renameTree(name) {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_rename_tree', { p_tree: tree.id, p_name: name });
    if (res.error) throw new Error(res.error.message);
    tree = Object.assign({}, tree, { name: res.data && res.data.name ? res.data.name : name });
    emitTree();
    return tree.name;
  }

  async function rotateInvite() {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_rotate_invite', { p_tree: tree.id });
    if (res.error) throw new Error(res.error.message);
    tree = Object.assign({}, tree, { invite_code: res.data });
    emitTree();
    return res.data;
  }

  async function setRole(userId, newRole) {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_set_member_role', {
      p_tree: tree.id, p_user: userId, p_role: newRole
    });
    if (res.error) throw new Error(res.error.message);
    await refreshMembersAsync();
  }

  async function removeMember(userId) {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_remove_member', { p_tree: tree.id, p_user: userId });
    if (res.error) throw new Error(res.error.message);
    await refreshMembersAsync();
  }

  async function refreshMembersAsync() {
    if (!client || !tree) return [];
    var res = await client.rpc('ft_list_members', { p_tree: tree.id });
    if (!res.error && Array.isArray(res.data)) {
      members = res.data;
      syncRoleFromMembers();
      if (handlers.onMembers) { try { handlers.onMembers(); } catch (e) { /* ignore */ } }
      emitStatus(status, statusText);
    }
    return members;
  }

  async function setMyName(name) {
    setProfileName(name);
    if (!client || !tree) return profileName();
    var res = await client.rpc('ft_set_my_name', { p_tree: tree.id, p_name: profileName() });
    if (res.error) throw new Error(res.error.message);
    await refreshMembersAsync();
    return profileName();
  }

  async function leaveTree() {
    if (!client || !tree) throw new Error('Нет общего древа');
    var res = await client.rpc('ft_leave_tree', { p_tree: tree.id });
    if (res.error) throw new Error(res.error.message);
    teardown();
  }

  function teardown() {
    if (channel && client) {
      try { client.removeChannel(channel); } catch (e) { /* ignore */ }
    }
    channel = null;
    tree = null;
    role = null;
    members = [];
    baseRevision = 0;
    knownBase = null;
    pendingStr = null;
    dirty = false;
    saving = false;
    emitStatus('ready', 'Вы не участвуете в общем древе');
    emitTree();
  }

  function saveConfig(url, key) {
    writeJSON(CONFIG_KEY, { url: String(url || '').trim(), anonKey: String(key || '').trim() });
  }
  function clearConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (e) { /* ignore */ }
  }

  function getState() {
    return {
      configured: isConfigured(),
      active: !!tree,
      status: status,
      statusText: statusText,
      treeName: tree ? tree.name : '',
      invite: tree ? tree.invite_code : '',
      role: role,
      userName: profileName(),
      members: members.slice(),
      canEdit: canEdit(),
      myId: user ? user.id : null,
      clientReady: !!client
    };
  }

  var api = {
    init: init,
    save: save,
    retry: retry,
    createTree: createTree,
    joinTree: joinTree,
    listVersions: listVersions,
    restoreVersion: restoreVersion,
    renameTree: renameTree,
    rotateInvite: rotateInvite,
    setRole: setRole,
    removeMember: removeMember,
    leaveTree: leaveTree,
    setMyName: setMyName,
    refreshMembers: refreshMembersAsync,
    setProfileName: setProfileName,
    profileName: profileName,
    getConfig: function () { var c = config(); return { url: c.url, anonKey: c.anonKey }; },
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    isConfigured: isConfigured,
    isActive: isActive,
    canEdit: canEdit,
    getState: getState,
    mergeData: mergeData
  };

  root.Cloud = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      mergeData: mergeData,
      mergeList: mergeList,
      mergeMap: mergeMap,
      canon: canon,
      eq: eq,
      contentSig: contentSig
    };
  }
})(typeof window !== 'undefined' ? window : this);
