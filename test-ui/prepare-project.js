'use strict';
// Готовит проекты и изолированный дом для items-smoke.js и items-stories.js.
// Всё пишется в /tmp/kabinet-smoke-home и /tmp/kabinet-smoke: настоящие настройки
// приложения и список недавних проектов не затрагиваются.
const fs = require('fs');
const path = require('path');
const project = require(path.join(__dirname, '..', 'src', 'project'));

const base = '/tmp/kabinet-smoke';
const home = '/tmp/kabinet-smoke-home';
fs.rmSync(base, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });

const novel = path.join(base, 'Роман');
const p = project.createProject(novel, 'Роман');
project.writeChapter(novel, p.chapters[0].id, 'Оруженосец вынес Экскалибур из ножен и подал его королю.');
const { id } = project.addItem(novel, 'item', null);
project.renameItem(novel, 'item', id, 'Экскалибур');
project.writeItem(novel, 'item', id, JSON.stringify({ short: 'меч короля', aliases: ['меч'], fields: [] }));

const stories = path.join(base, 'Рассказы');
project.createProject(stories, 'Сборник', { mode: 'stories' });
const s = project.addItem(stories, 'item', null);
project.renameItem(stories, 'item', s.id, 'Бинокль');

const recents = path.join(home, '.config', 'Кабинет', 'recent-projects.json');
fs.mkdirSync(path.dirname(recents), { recursive: true });
fs.writeFileSync(recents, JSON.stringify([
  { path: novel, name: 'Роман' },
  { path: stories, name: 'Сборник' },
], null, 2));
console.log('готово:', base, 'и', home);
