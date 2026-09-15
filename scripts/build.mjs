#!/usr/bin/env node
/* ============================================================
   构建脚本（Netlify 部署时自动运行，本地也可手动运行）
   ------------------------------------------------------------
   流程：
     1. 扫描根目录所有《xx》.md 文章
     2. 确定类别：data/meta.json 覆盖 → .build-cache.json 缓存 →
        豆瓣书/影接口自动识别（书影同名时按正文关键词投票，
        仍无法判定默认书评）
     3. 解析封面：手动指定 → 豆瓣（带 Referer 绕防盗链）→
        Google Books（书）→ TMDB（影，需 TMDB_KEY 环境变量）→
        都失败则前端渲染文字题图
     4. 生成 posts/index.json + posts/{文件名}.json + covers/*.jpg
        并把豆瓣解析结果写入 .build-cache.json（随仓库提交，
        老文章下次构建直接复用，不再请求接口，避免被限流）

   对豆瓣的请求做了间隔与退避：suggest 结果为空可能只是被限流，
   会自动重试。构建日志打印每篇的分类与封面来源，便于抽查。
   ============================================================ */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TMDB_KEY = process.env.TMDB_KEY || '';
const CACHE_FILE = resolve(ROOT, '.build-cache.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 网络工具 ---------- */

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function download(url, dest) {
  // 豆瓣图片有防盗链：必须带 Referer
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.douban.com/' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 3000) throw new Error('图片过小');
      writeFileSync(dest, buf);
      return true;
    } catch (e) {
      if (i === 1) return false;
      await sleep(800);
    }
  }
  return false;
}

/* 豆瓣 suggest：空结果可能是被限流，退避重试 */
async function suggest(host, q) {
  const delays = [0, 2000, 4500];
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      const list = await getJSON(`https://${host}/j/subject_suggest?q=${encodeURIComponent(q)}`);
      if (Array.isArray(list) && list.length) return list;
    } catch { /* 重试 */ }
  }
  return [];
}

const norm = s => (s || '').replace(/[\s《》〈〉:：·・\-—"'“”‘’]/g, '');
const matchTitle = (list, t) => (list || []).filter(x => {
  const a = norm(x.title), b = norm(t);
  return a.includes(b) || b.includes(a);
});

/* ---------- 封面备用来源 ---------- */

async function googleBooks(title) {
  try {
    const d = await getJSON('https://www.googleapis.com/books/v1/volumes?maxResults=10&q=' + encodeURIComponent(title));
    for (const it of (d.items || [])) {
      const vi = it.volumeInfo || {};
      const links = vi.imageLinks || {};
      const base = links.thumbnail || links.smallThumbnail;
      if (base && norm(vi.title).includes(norm(title))) {
        const clean = base.replace(/^http:/, 'https:').replace(/&edge=curl/, '').replace(/&source=gbs_api/, '');
        const big = /&zoom=\d+/.test(clean) ? clean.replace(/&zoom=\d+/, '&zoom=1') : clean;
        return [big, clean];
      }
    }
  } catch { /* 网络不可达则跳过 */ }
  return [];
}

async function tmdb(title) {
  if (!TMDB_KEY) return [];
  try {
    const d = await getJSON(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent(title)}`);
    const hit = (d.results || [])[0];
    if (hit && hit.poster_path) {
      return [
        'https://image.tmdb.org/t/p/w500' + hit.poster_path,
        'https://image.tmdb.org/t/p/original' + hit.poster_path
      ];
    }
  } catch { /* 跳过 */ }
  return [];
}

/* 小图地址 → 大图地址 */
function toLarge(u) {
  return u
    .replace('/view/subject/s/public/', '/view/subject/l/public/')
    .replace('/view/photo/s_ratio_poster/', '/view/photo/l_ratio_poster/')
    .replace('/view/photo/sqxs/', '/view/photo/l/');
}

/* ---------- 书影同名时的正文关键词投票 ---------- */

function voteCounts(content) {
  const head = (content || '').slice(0, 900);
  const mv = (head.match(/电影|影片|导演|剧中|剧版|编剧|动画|动漫|本片|台词|镜头|画面|观众|主演|演员|看番|纪录片|番剧|剧集|追剧/g) || []).length;
  const bk = (head.match(/本书|作者|小说|书中|原著|译者|出版社|短篇|文集|读到|翻看|书评/g) || []).length;
  return [mv, bk];
}

/* 豆瓣条目封面地址：影库字段是 img，书库字段是 pic */
const hitImg = h => (h && (h.img || h.pic)) || '';

/* ---------- Markdown 渲染（使用 marked，支持 GFM 表格/列表/代码块） ---------- */

function renderMd(text) {
  // 兼容旧写法：长破折号行后同行跟的说明文字，拆成 hr + 说明段落
  const pre = String(text || '').replace(
    /^(\s*)([-—─]{6,})([^\n]*)$/gm,
    (_, space, dashes, note) => {
      const n = note.trim();
      return n ? `${space}---\n\n${space}${n}` : `${space}---`;
    }
  );

  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: false,
    mangle: false
  });

  const renderer = new marked.Renderer();
  renderer.hr = () => '<hr class="ps-rule">';

  let html = marked.parse(pre, { renderer });

  // 给表格加样式类
  html = html.replace(/<table>/g, '<table class="data-table">');

  // 把 hr 后面紧跟着的说明段落标记为 ps-note；纯标记词则丢弃
  html = html.replace(
    /(<hr class="ps-rule">)\s*<p>([^<]+)<\/p>/g,
    (_, hr, note) => {
      const t = note.trim();
      if (/^(分割线|分界线|分隔线)$/.test(t)) return hr;
      return hr + '<p class="ps-note">' + t + '</p>';
    }
  );

  return html.trim();
}

/* ---------- 主流程 ---------- */

async function main() {
  const files = readdirSync(ROOT).filter(f => f.endsWith('.md') && f !== 'README.md').sort();
  const meta = (() => {
    try { return JSON.parse(readFileSync(resolve(ROOT, 'data/meta.json'), 'utf8')); } catch { return {}; }
  })();
  const cache = (() => {
    try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
  })();

  mkdirSync(resolve(ROOT, 'posts'), { recursive: true });
  mkdirSync(resolve(ROOT, 'covers'), { recursive: true });

  const resolved = {};
  const index = [];
  let cacheDirty = false;

  for (const file of files) {
    const id = file.replace(/\.md$/, '');
    const raw = readFileSync(resolve(ROOT, file), 'utf8');
    const override = meta[id] || {};

    // 作品名取自文件名《…》；展示标题取自正文首个 # 标题
    const workTitle = (file.match(/《(.+?)》/) || [])[1] || id;
    const displayTitle = (raw.match(/^#\s+(.+)$/m) || [])[1] || `《${workTitle}》`;

    // —— 分类与豆瓣条目 ——
    // 优先级：meta.json 手动 > .build-cache.json 缓存 > 豆瓣自动识别
    // 搜索词：meta.json 的 aka 字段可指定豆瓣里的正式译名（如《离线找真爱》
    // 在豆瓣叫《线下恋爱》）。只查「还缺的那一侧」：类型已定为影评且影库
    // 条目在缓存里，就不再请求书库；被限流没查到的侧，下次构建自动补查。
    const c = cache[workTitle] || {};
    let bookHit = c.bookHit || null;
    let movieHit = c.movieHit || null;
    let type = override.type || c.type || null;
    let typeSrc = override.type ? '手动' : (c.typeSrc || '缓存');
    const searchTitle = override.aka || workTitle;

    // 专题且信息行齐全：完全不需要查豆瓣
    const skipQuery = type === 'essay' && override.byline;

    if (!skipQuery) {
      const wanted = type === 'movie' ? ['movie'] : type === 'book' ? ['book'] : ['book', 'movie'];
      const todo = wanted.filter(side => (side === 'book' ? !bookHit : !movieHit));
      for (let i = 0; i < todo.length; i++) {
        const side = todo[i];
        const list = await suggest(side === 'book' ? 'book.douban.com' : 'movie.douban.com', searchTitle);
        const hit = matchTitle(list, searchTitle)[0] || null;
        if (side === 'book') bookHit = hit; else movieHit = hit;
        if (i < todo.length - 1) await sleep(500);
      }

      if (!type) {
        const [mv, bk] = voteCounts(raw);
        if (bookHit && movieHit) {
          type = mv > bk ? 'movie' : 'book'; typeSrc = '同名投票';
        } else if (bookHit && mv >= 2 && bk === 0) {
          type = 'movie'; typeSrc = '关键词否决书库';
        } else if (movieHit && bk >= 2 && mv === 0) {
          type = 'book'; typeSrc = '关键词否决影库';
        } else if (bookHit) {
          type = 'book'; typeSrc = '豆瓣书库';
        } else if (movieHit) {
          type = 'movie'; typeSrc = '豆瓣影库';
        } else {
          type = mv > bk ? 'movie' : 'book'; typeSrc = mv > bk ? '仅关键词' : '未匹配→默认书';
        }
      }

      // 只有真拿到条目才写缓存（空结果多半是被限流，不能永久缓存）
      if (bookHit || movieHit) {
        cache[workTitle] = { type, typeSrc, bookHit, movieHit };
        cacheDirty = true;
      } else if (cache[workTitle] && !cache[workTitle].type) {
        delete cache[workTitle];
        cacheDirty = true;
      }
    }

    // —— 作品信息行 ——
    let byline = override.byline;
    if (!byline && type !== 'essay') {
      const hit = type === 'movie' ? movieHit : bookHit;
      if (hit) {
        const parts = [`《${workTitle}》`];
        const sub = type === 'movie' ? (hit.sub_title || '') : (hit.author_name || '');
        if (sub) parts.push(sub);
        if (hit.year) parts.push(hit.year);
        byline = parts.join(' · ');
      } else {
        byline = `《${workTitle}》`;
      }
    }

    // —— 封面候选（专题一律用文字题图） ——
    const cands = [];
    let coverSrc = '';
    if (override.cover) { cands.push(override.cover); coverSrc = '手动指定'; }

    let hit = type === 'movie' ? movieHit : bookHit;
    if (type === 'movie' && hit && !hitImg(hit)) {
      // 番剧常以「第一季」收录且带海报
      const season = matchTitle(await suggest('movie.douban.com', searchTitle + ' 第一季'), searchTitle)[0];
      if (season && hitImg(season)) hit = season;
    }
    if (type !== 'essay' && hit && hitImg(hit) && !cands.length) {
      cands.push(toLarge(hitImg(hit)), hitImg(hit));
      coverSrc = '豆瓣';
    }
    if (!cands.length && type === 'book') {
      const urls = await googleBooks(workTitle);
      if (urls.length) { cands.push(...urls); coverSrc = 'Google Books'; }
    }
    if (!cands.length && type === 'movie') {
      const urls = await tmdb(workTitle);
      if (urls.length) { cands.push(...urls); coverSrc = 'TMDB'; }
    }
    resolved[id] = cands;

    // —— 下载第一张可用图（已有本地文件则跳过） ——
    const coverPath = resolve(ROOT, 'covers', `${id}.jpg`);
    let hasCover = existsSync(coverPath);
    if (hasCover) { coverSrc = coverSrc || '本地已有'; }
    if (!hasCover) {
      for (const u of cands) {
        if (await download(u, coverPath)) { hasCover = true; break; }
        await sleep(200);
      }
    }

    // —— 正文（长破折号行由 renderMd 渲染为分界线）——
    const main = raw.replace(/^#\s+.+\n+/, '');
    const minutes = Math.max(1, Math.ceil(main.replace(/\s/g, '').length / 400));

    writeFileSync(
      resolve(ROOT, 'posts', `${id}.json`),
      JSON.stringify({
        id, title: displayTitle, type, byline, minutes,
        cover: hasCover, workTitle,
        content: renderMd(main)
      }, null, 0) + '\n'
    );

    index.push({ id, title: displayTitle, type, minutes, cover: hasCover, workTitle });
    console.log(`[build] ${file} → ${type}（${typeSrc}）封面：${hasCover ? coverSrc : '文字题图'}`);
    await sleep(600);
  }

  writeFileSync(resolve(ROOT, 'posts', 'index.json'), JSON.stringify(index) + '\n');
  writeFileSync(resolve(ROOT, 'covers-resolved.json'), JSON.stringify(resolved, null, 2) + '\n');
  if (cacheDirty) writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');

  const tally = t => index.filter(p => p.type === t).length;
  const covered = index.filter(p => p.cover).length;
  console.log('\n===== 构建汇总 =====');
  console.log(`文章 ${index.length} 篇｜书评 ${tally('book')} · 影评 ${tally('movie')} · 专题 ${tally('essay')}`);
  console.log(`封面：已获取 ${covered} · 文字题图 ${index.length - covered}`);
  if (index.length - covered > 0) {
    console.log('未获封面的文章（可手动放 covers/同名.jpg 或配置 TMDB_KEY）：');
    index.filter(p => !p.cover).forEach(p => console.log('  - ' + p.id));
  }
}

main().catch(e => {
  console.error('[build] 失败：', e);
  process.exit(1);
});
