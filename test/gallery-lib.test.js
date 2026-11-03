const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Lib = require('../lib.js');

const csvPath = path.join(__dirname, '..', 'index.csv');
const csvText = fs.readFileSync(csvPath, 'utf8');

test('parses the shipped index and the quoted note', () => {
  const rows = Lib.parseCSV(csvText);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].path, '周边设计/亚克力/2026-11-03_DWW双面亚克力立牌.jpg');
  assert.deepEqual(Lib.parseTags(rows[0].tags), ['亚克力立牌', '哥特暗黑', '双面印刷', 'VTuber']);
  const special = rows.find((row) => row.path.includes('女之园之星'));
  assert.equal(special.note, '带来好运的贴纸"概念包装，卡片式贴纸附幻彩（BOOTH收藏3943）');
  const again = Lib.parseCSV(Lib.serializeCSV(rows, Lib.detectNewline(csvText)));
  assert.deepEqual(again, rows);
});

test('titles drop the date prefix and extension', () => {
  assert.equal(Lib.titleFromFilename('周边设计/挂件/2026-11-03_草莓蛋糕标本挂件.jpg'), '草莓蛋糕标本挂件');
  assert.equal(Lib.encodePath('周边设计/亚克力/2026-11-03_DWW双面亚克力立牌.jpg').includes('%'), true);
  assert.equal(Lib.encodePath('周边设计/亚克力/a.jpg').startsWith('周边设计/'), false);
});

test('search covers title, note and tags only', () => {
  const items = Lib.parseCSV(csvText).map(Lib.decorateRow);
  assert.equal(Lib.filterItems(items, { q: '草莓' }).length, 1);
  assert.equal(Lib.filterItems(items, { q: 'BOOTH收藏12843' }).length, 1);
  assert.equal(Lib.filterItems(items, { q: 'VTuber', c1: '周边设计', c2: '亚克力' }).length, 2);
  assert.equal(Lib.filterItems(items, { c1: '周边设计', c2: '吧唧' }).length, 2);
  const onlyCategory = items.filter((item) => !`${item.title}\n${item.note}\n${item.tags.join(' ')}`.includes('不存在的分类词'));
  assert.equal(onlyCategory.length, 20);
  assert.equal(Lib.filterItems(items, { q: '不存在的分类词' }).length, 0);
});

test('uploads are named YYYY-MM-DD_简述.ext and stay unique', () => {
  const rows = Lib.parseCSV(csvText);
  const doc = { categories: [] };
  const planned = Lib.planUploads(rows, doc, [
    { title: '2026-11-03_新立牌', ext: 'jpeg' },
    { title: '新立牌', ext: 'jpg' },
    { title: '新立牌', ext: 'png' },
  ], {
    c1: '周边设计',
    c2: '亚克力',
    tags: '立牌|新品',
    note: '含逗号,需要引号',
    source: 'https://example.com/a',
  }, '2026-11-03');
  assert.equal(planned.planned[0].path, '周边设计/亚克力/2026-11-03_新立牌.jpg');
  assert.equal(planned.planned[1].path, '周边设计/亚克力/2026-11-03_新立牌-2.jpg');
  assert.equal(planned.planned[2].path, '周边设计/亚克力/2026-11-03_新立牌.png');
  assert.equal(planned.rows.at(-1).note, '含逗号,需要引号');
  assert.match(Lib.serializeCSV(planned.rows, '\n'), /"含逗号,需要引号"/);
  assert.equal(planned.doc.categories[0].subs.includes('亚克力'), true);
});

test('moving a file rewrites the path and keeps the row', () => {
  const rows = Lib.parseCSV(csvText);
  const target = rows[0].path;
  const updated = Lib.updateImage(rows, target, { c1: '周边设计', c2: '吧唧', tags: ['只剩一个'] });
  assert.equal(updated.moves[0].from, target);
  assert.equal(updated.moves[0].to, '周边设计/吧唧/2026-11-03_DWW双面亚克力立牌.jpg');
  assert.equal(updated.rows[0].tags, '只剩一个');
  assert.equal(updated.rows[0].note, rows[0].note);
});

test('empty categories live in categories.json and deletion can move images', () => {
  const rows = Lib.parseCSV(csvText);
  const doc = Lib.normalizeCategories({ categories: [{ name: '周边设计', subs: ['亚克力', '空分类'] }] });
  const tax = Lib.listTaxonomy(rows, doc);
  assert.deepEqual(tax[0].subs.includes('空分类') && tax[0].subs.includes('挂件'), true);
  const added = Lib.addCategory(doc, '新顶类', '');
  assert.equal(added.created, true);
  assert.equal(Lib.addCategory(added.doc, '新顶类', '').created, false);
  const removed = Lib.deleteCategory(rows, doc, '周边设计', '吧唧', {
    type: 'move',
    c1: '周边设计',
    c2: '其他',
  });
  assert.equal(removed.rows.some((row) => row.category === '周边设计/吧唧'), false);
  assert.equal(removed.moves.length, 2);
  assert.equal(Lib.imagesIn(removed.rows, '周边设计', '其他').length, 4);
  const dropped = Lib.deleteCategory(rows, doc, '周边设计', '毛绒', { type: 'delete-images' });
  assert.equal(dropped.rows.length, 18);
  assert.deepEqual(dropped.deletes.length, 2);
});
