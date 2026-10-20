/* Семейное древо — service worker: кэш-сначала, работа офлайн. */
'use strict';

const CACHE = 'family-tree-v12';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './tree.js',
  './app.js',
  './cloud.js',
  './cloud-config.js',
  './vendor/supabase.js',
  './supabase/schema.sql',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && req.url.indexOf('http') === 0) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => {
        /* офлайн: для навигации отдаём главную страницу */
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
