import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { frontendRoot, backgroundFile } from '../gallery.mjs';

const publicRoot = new URL('../../public/', import.meta.url);
export const policy = (hash) =>
  `default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' ${hash ? `'sha256-${hash}'` : ''}; frame-ancestors 'none'; base-uri 'none'`;

export async function serveStatic(req, res, u, json) {
  if (req.method !== 'GET') return json(res, 405, { error: '不支持的操作' });
  if (u.pathname.startsWith('/Image169/')) {
    const image = await backgroundFile(
      decodeURIComponent(u.pathname.slice('/Image169/'.length)),
    );
    if (!image) return json(res, 404, { error: '背景图片不存在' });
    res.setHeader('Content-Type', image.type);
    return res.end(image.data);
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    res.setHeader(
      'Content-Security-Policy',
      policy(script ? createHash('sha256').update(script).digest('base64') : ''),
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  /* 浏览器可下载的静态文件白名单；新增前端文件时需同时在这里登记路径。 */
  const paths = {
    '/': 'index.html',
    '/app.js': 'app.js',
    '/app-state.js': 'app-state.js',
    '/gallery-ui.js': 'gallery-ui.js',
    '/gallery-modes.js': 'gallery-modes.js',
    '/styles/gallery-modes.css': 'styles/gallery-modes.css',
    '/playback-ui.js': 'playback-ui.js',
    '/playlist-ui.js': 'playlist-ui.js',
    '/account-ui.js': 'account-ui.js',
    '/visualizer.js': 'visualizer.js',
    '/media.mjs': 'media.mjs',
    '/track-state.mjs': 'track-state.mjs',
    '/queue.mjs': 'queue.mjs',
    '/style.css': 'style.css',
    '/player-core.js': 'player-core.js',
    '/media-engine.js': 'media-engine.js',
    '/playback-session.js': 'playback-session.js',
    '/listening.js': 'listening.js',
    '/api-client.js': 'api-client.js',
    '/lyrics.js': 'lyrics.js',
    '/backgrounds.js': 'backgrounds.js',
    '/ambient-background.js': 'ambient-background.js',
    '/styles/ambient-background.css': 'styles/ambient-background.css',
    '/search.js': 'search.js',
    '/spine-jump.js': 'spine-jump.js',
    '/search-transition.js': 'search-transition.js',
    '/styles/spine-jump.css': 'styles/spine-jump.css',
    '/settings.js': 'settings.js',
    '/settings-panel.js': 'settings-panel.js',
    '/styles/settings-panel.css': 'styles/settings-panel.css',
    '/styles/panel-pages.css': 'styles/panel-pages.css',
    '/desktop.js': 'desktop.js',
    '/local-files-ui.js': 'local-files-ui.js',
    '/cache-ui.js': 'cache-ui.js',
    '/styles/base.css': 'styles/base.css',
    '/styles/player.css': 'styles/player.css',
    '/styles/lyrics.css': 'styles/lyrics.css',
    '/styles/vertical-gallery.css': 'styles/vertical-gallery.css',
  };
  const file = paths[u.pathname];
  if (!file) return json(res, 404, { error: '页面不存在' });
  const data = await readFile(new URL(file, publicRoot));
  res.setHeader(
    'Content-Type',
    file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css'
        : 'text/javascript',
  );
  return res.end(data);
}
