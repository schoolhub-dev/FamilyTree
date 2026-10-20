'use strict';

var CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

import(CDN_URL)
  .then(function (mod) {
    if (!mod || typeof mod.createClient !== 'function') {
      throw new Error('Модуль загрузился, но createClient в нём не найден: ' + CDN_URL);
    }
    window.supabase = { createClient: mod.createClient };
    window.dispatchEvent(new Event('supabase-ready'));
  })
  .catch(function (err) {
    console.error('[Supabase] Не удалось загрузить библиотеку с CDN ' + CDN_URL + ':', err);
    window.__supabaseLoadError = err;
    window.dispatchEvent(new Event('supabase-failed'));
  });
