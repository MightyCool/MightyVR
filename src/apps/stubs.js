import { pcStream } from './pcstream.js';
import { browser } from './browser.js';
import { settingsApp } from './settings.js';
import { arGame } from './arGame.js';

/** App API: { id, name, icon, init(ctx), update(dt), dispose() }. ctx = { text(lines), button(opts), parent, scene, actions }. */
export const apps = [
  settingsApp,
  browser,
  pcStream,
  arGame,
];
