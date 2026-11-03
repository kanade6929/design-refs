/* global globalThis */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GalleryLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BASE_HEADERS = ['path', 'category', 'tags', 'source', 'note', 'saved'];

  function parseCSV(text) {
    let src = String(text || '');
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const table = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;
    while (i < src.length) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (c === ',') {
        row.push(field);
        field = '';
        i += 1;
        continue;
      }
      if (c === '\r' || c === '\n') {
        row.push(field);
        field = '';
        table.push(row);
        row = [];
        if (c === '\r' && src[i + 1] === '\n') i += 2;
        else i += 1;
        continue;
      }
      field += c;
      i += 1;
    }
    if (field.length || row.length) {
      row.push(field);
      table.push(row);
    }
    if (!table.length) return [];
    const headers = table[0].map((h) => h.trim());
    const out = [];
    for (let r = 1; r < table.length; r += 1) {
      const cols = table[r];
      if (cols.every((col) => col === '')) continue;
      const obj = {};
      headers.forEach((header, idx) => {
        if (!header) return;
        obj[header] = cols[idx] ?? '';
      });
      out.push(obj);
    }
    return out;
  }

  function detectNewline(text) {
    let crlf = 0;
    let lf = 0;
    const src = String(text || '');
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] !== '\n') continue;
      if (src[i - 1] === '\r') crlf += 1;
      else lf += 1;
    }
    if (!crlf && !lf) return '\n';
    return crlf >= lf ? '\r\n' : '\n';
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function headersFrom(rows) {
    const seen = [];
    const add = (key) => {
      if (key && !seen.includes(key)) seen.push(key);
    };
    BASE_HEADERS.forEach(add);
    rows.forEach((row) => Object.keys(row).forEach(add));
    return seen;
  }

  function serializeCSV(rows, newline) {
    const nl = newline === '\r\n' ? '\r\n' : '\n';
    const headers = headersFrom(rows);
    const lines = [headers.join(',')];
    rows.forEach((row) => {
      lines.push(headers.map((header) => csvEscape(row[header] ?? '')).join(','));
    });
    return lines.join(nl) + nl;
  }

  function encodePath(path) {
    return String(path || '')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  function titleFromFilename(path) {
    const base = String(path || '').split('/').pop() || '';
    const noExt = base.replace(/\.[^.]+$/, '');
    return noExt.replace(/^\d{4}-\d{2}-\d{2}_/, '') || noExt || base;
  }

  function splitCategory(category) {
    const parts = String(category || '')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    return { c1: parts[0] || '', c2: parts.slice(1).join('/') };
  }

  function formatCategory(c1, c2) {
    return c2 ? `${c1}/${c2}` : c1;
  }

  function sanitizeCategoryName(name) {
    const s = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .trim();
    if (!s || s === '全部') throw new Error('分类名称无效');
    return s.slice(0, 40);
  }

  function sanitizeBaseName(name) {
    let s = String(name || '').trim().replace(/^\d{4}-\d{2}-\d{2}_/, '');
    s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '');
    s = s.replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    return s.slice(0, 80).trim();
  }

  function cleanExtension(ext) {
    let e = String(ext || '').replace(/^\./, '').toLowerCase();
    if (e === 'jpeg') e = 'jpg';
    if (!/^[a-z0-9]{1,5}$/.test(e)) e = 'jpg';
    return e;
  }

  function parseTags(value) {
    return String(value || '')
      .split('|')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function joinTags(tags) {
    const seen = new Set();
    const out = [];
    (tags || []).forEach((tag) => {
      const value = String(tag).trim();
      if (!value || seen.has(value)) return;
      if (/[|\r\n]/.test(value)) throw new Error('标签不能包含 | 或换行');
      seen.add(value);
      out.push(value);
    });
    return out;
  }

  function assertSource(source) {
    if (!source) return;
    if (!/^https?:\/\//i.test(source)) throw new Error('来源需要以 http:// 或 https:// 开头');
  }

  function todayStamp(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date || new Date());
    const get = (type) => parts.find((part) => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function decorateRow(row) {
    const split = splitCategory(row.category);
    return {
      path: row.path,
      category: row.category,
      tags: parseTags(row.tags),
      source: row.source || '',
      note: row.note || '',
      saved: row.saved || '',
      title: titleFromFilename(row.path),
      c1: split.c1,
      c2: split.c2,
    };
  }

  function itemMatchesQuery(item, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return true;
    const hay = [item.title, item.note, ...(item.tags || [])].join('\n').toLowerCase();
    return hay.includes(needle);
  }

  function filterItems(items, criteria) {
    const c1 = criteria.c1 || '全部';
    const c2 = criteria.c2 || '全部';
    const tag = criteria.tag || '全部';
    return items.filter((item) => {
      if (c1 !== '全部' && item.c1 !== c1) return false;
      if (c2 !== '全部' && item.c2 !== c2) return false;
      if (tag !== '全部' && !(item.tags || []).includes(tag)) return false;
      return itemMatchesQuery(item, criteria.q);
    });
  }

  function normalizeCategories(doc) {
    const list = Array.isArray(doc && doc.categories) ? doc.categories : [];
    const categories = [];
    list.forEach((item) => {
      if (!item || typeof item.name !== 'string') return;
      let name;
      try {
        name = sanitizeCategoryName(item.name);
      } catch (err) {
        return;
      }
      const subs = [];
      (item.subs || []).forEach((sub) => {
        try {
          const value = sanitizeCategoryName(sub);
          if (!subs.includes(value)) subs.push(value);
        } catch (err) {
          /* skip invalid */
        }
      });
      const existing = categories.find((cat) => cat.name === name);
      if (existing) {
        subs.forEach((sub) => {
          if (!existing.subs.includes(sub)) existing.subs.push(sub);
        });
      } else {
        categories.push({ name, subs });
      }
    });
    return { categories };
  }

  function listTaxonomy(rows, doc) {
    const order = [];
    const map = new Map();
    const ensure = (name) => {
      if (!map.has(name)) {
        map.set(name, []);
        order.push(name);
      }
      return map.get(name);
    };
    normalizeCategories(doc).categories.forEach((cat) => {
      const subs = ensure(cat.name);
      cat.subs.forEach((sub) => {
        if (!subs.includes(sub)) subs.push(sub);
      });
    });
    rows.forEach((row) => {
      const split = splitCategory(row.category);
      if (!split.c1) return;
      const subs = ensure(split.c1);
      if (split.c2 && !subs.includes(split.c2)) subs.push(split.c2);
    });
    return order.map((name) => ({ name, subs: map.get(name) }));
  }

  function addCategory(doc, rawC1, rawC2) {
    const c1 = sanitizeCategoryName(rawC1);
    const c2 = rawC2 ? sanitizeCategoryName(rawC2) : '';
    const next = normalizeCategories(doc);
    let cat = next.categories.find((item) => item.name === c1);
    const had = !!cat && (!c2 || cat.subs.includes(c2));
    if (!cat) {
      cat = { name: c1, subs: [] };
      next.categories.push(cat);
    }
    if (c2 && !cat.subs.includes(c2)) cat.subs.push(c2);
    return { doc: next, created: !had, c1, c2 };
  }

  function removeCategory(doc, c1, c2) {
    const next = normalizeCategories(doc);
    if (!c2) next.categories = next.categories.filter((cat) => cat.name !== c1);
    else {
      const cat = next.categories.find((item) => item.name === c1);
      if (cat) cat.subs = cat.subs.filter((sub) => sub !== c2);
    }
    return next;
  }

  function categoryExists(rows, doc, c1, c2) {
    const cat = listTaxonomy(rows, doc).find((item) => item.name === c1);
    if (!cat) return false;
    if (!c2) return true;
    return cat.subs.includes(c2);
  }

  function imagesIn(rows, c1, c2) {
    return rows.filter((row) => {
      const split = splitCategory(row.category);
      if (split.c1 !== c1) return false;
      if (c2) return split.c2 === c2;
      return true;
    });
  }

  function uniqueDest(dir, filename, taken) {
    const match = filename.match(/^(.*?)(\.[^.]+)$/);
    const stem = match ? match[1] : filename;
    const ext = match ? match[2] : '';
    let i = 2;
    let dest = `${dir}/${filename}`;
    while (taken.has(dest)) {
      dest = `${dir}/${stem}-${i}${ext}`;
      i += 1;
    }
    return dest;
  }

  function allocateUploadPath(dir, title, ext, dateStamp, taken) {
    const base = sanitizeBaseName(title);
    if (!base) throw new Error('请填写标题');
    const cleanExt = cleanExtension(ext);
    let n = 1;
    let dest = '';
    do {
      const stem = n === 1 ? `${dateStamp}_${base}` : `${dateStamp}_${base}-${n}`;
      dest = `${dir}/${stem}.${cleanExt}`;
      n += 1;
    } while (taken.has(dest));
    taken.add(dest);
    return dest;
  }

  function planUploads(rows, doc, files, meta, dateStamp) {
    const c1 = sanitizeCategoryName(meta.c1);
    const c2 = meta.c2 ? sanitizeCategoryName(meta.c2) : '';
    const tags = joinTags(Array.isArray(meta.tags) ? meta.tags : parseTags(meta.tags || ''));
    const note = meta.note == null ? '' : String(meta.note).trim();
    const source = String(meta.source || '').trim();
    assertSource(source);
    const taken = new Set(rows.map((row) => row.path));
    const dir = formatCategory(c1, c2);
    const planned = files.map((file) => ({
      path: allocateUploadPath(dir, file.title, file.ext, dateStamp, taken),
    }));
    const category = formatCategory(c1, c2);
    const newRows = rows.concat(
      planned.map((item) => ({
        path: item.path,
        category,
        tags: tags.join('|'),
        source,
        note,
        saved: dateStamp,
      }))
    );
    return { rows: newRows, doc: addCategory(doc, c1, c2).doc, planned };
  }

  function updateImage(rows, path, patch) {
    const index = rows.findIndex((row) => row.path === path);
    if (index < 0) throw new Error('这张图片已经不在 index.csv 里');
    const row = { ...rows[index] };
    if (patch.tags) row.tags = joinTags(patch.tags).join('|');
    if (patch.note != null) row.note = String(patch.note).trim();
    if (patch.source != null) {
      const source = String(patch.source).trim();
      assertSource(source);
      row.source = source;
    }
    const deletes = [];
    const moves = [];
    if (patch.c1) {
      const c1 = sanitizeCategoryName(patch.c1);
      const c2 = patch.c2 ? sanitizeCategoryName(patch.c2) : '';
      const category = formatCategory(c1, c2);
      if (category !== row.category) {
        const filename = row.path.split('/').pop();
        const dir = formatCategory(c1, c2);
        const taken = new Set(rows.map((item) => item.path));
        taken.delete(row.path);
        let dest = `${dir}/${filename}`;
        if (taken.has(dest)) dest = uniqueDest(dir, filename, taken);
        deletes.push(row.path);
        moves.push({ from: row.path, to: dest });
        row.path = dest;
        row.category = category;
      }
    }
    const next = rows.slice();
    next[index] = row;
    return { rows: next, deletes, moves };
  }

  function removeImage(rows, path) {
    if (!rows.some((row) => row.path === path)) throw new Error('这张图片已经不在 index.csv 里');
    return { rows: rows.filter((row) => row.path !== path), deletes: [path] };
  }

  function deleteCategory(rows, doc, c1, c2, action) {
    const targets = imagesIn(rows, c1, c2);
    if (targets.length && (!action || !action.type)) throw new Error('这个分类里还有图片');
    const nextDoc = removeCategory(doc, c1, c2);
    if (!targets.length) return { rows, doc: nextDoc, deletes: [], moves: [] };
    if (action.type === 'delete-images') {
      const drop = new Set(targets.map((row) => row.path));
      return {
        rows: rows.filter((row) => !drop.has(row.path)),
        doc: nextDoc,
        deletes: [...drop],
        moves: [],
      };
    }
    if (action.type === 'move') {
      const destC1 = sanitizeCategoryName(action.c1);
      const destC2 = action.c2 ? sanitizeCategoryName(action.c2) : '';
      const sameParent = destC1 === c1 && (!c2 || destC2 === c2);
      if (!c2 && destC1 === c1) throw new Error('请选择另一个分类');
      if (c2 && destC1 === c1 && destC2 === c2) throw new Error('请选择另一个分类');
      if (sameParent && c2 && destC2 === c2) throw new Error('请选择另一个分类');
      const dir = formatCategory(destC1, destC2);
      const taken = new Set(rows.map((row) => row.path));
      const drop = new Set(targets.map((row) => row.path));
      drop.forEach((path) => taken.delete(path));
      const moves = [];
      const nextRows = rows.map((row) => {
        if (!drop.has(row.path)) return row;
        const filename = row.path.split('/').pop();
        let dest = `${dir}/${filename}`;
        if (taken.has(dest)) dest = uniqueDest(dir, filename, taken);
        taken.add(dest);
        moves.push({ from: row.path, to: dest });
        return { ...row, path: dest, category: formatCategory(destC1, destC2) };
      });
      return { rows: nextRows, doc: nextDoc, deletes: moves.map((move) => move.from), moves };
    }
    throw new Error('未知操作');
  }

  return {
    parseCSV,
    detectNewline,
    serializeCSV,
    encodePath,
    titleFromFilename,
    splitCategory,
    formatCategory,
    sanitizeCategoryName,
    sanitizeBaseName,
    cleanExtension,
    parseTags,
    joinTags,
    todayStamp,
    decorateRow,
    itemMatchesQuery,
    filterItems,
    normalizeCategories,
    listTaxonomy,
    addCategory,
    removeCategory,
    categoryExists,
    imagesIn,
    planUploads,
    updateImage,
    removeImage,
    deleteCategory,
  };
});
