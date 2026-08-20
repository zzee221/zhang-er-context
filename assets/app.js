/* ============================================================
   张二的上下文 —— 前端渲染（封面墙 + 文章页）
   数据全部来自构建时生成的 posts/*.json
   ============================================================ */
(function () {
  'use strict';

  var LABELS = { book: '书评', movie: '影评', essay: '专题' };
  var TYPE_ORDER = ['book', 'movie', 'essay'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function encId(id) { return encodeURIComponent(id); }

  /* ---------- 封面渲染 ----------
     本地 covers/{id}.jpg 加载失败时，依次尝试构建时
     解析出的原始图链（covers-resolved.json），全部失败
     则替换为文字题图。 */

  var resolvedCache = null;
  function loadResolved() {
    if (resolvedCache) return resolvedCache;
    resolvedCache = fetch('covers-resolved.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
    return resolvedCache;
  }

  function frameHTML(workTitle, type) {
    return '<div class="frame-inner">' +
      '<span class="frame-title">' + esc(workTitle) + '</span>' +
      '<span class="frame-type">' + (LABELS[type] || '专题') + '</span>' +
      '</div>';
  }

  function mountCover(cov, post) {
    if (!post.cover) {
      cov.classList.add('is-frame');
      cov.innerHTML = frameHTML(post.workTitle, post.type);
      return;
    }
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = (post.workTitle || post.title) + ' 封面';
    // 书籍封面裁切时保留顶部（书名区），电影海报保持居中
    if (post.type === 'book') img.style.objectPosition = 'top';
    img.onload = function () { img.classList.add('is-loaded'); };
    img.onerror = function () {
      // 本地文件缺失 → 试远程候选 → 文字题图
      loadResolved().then(function (all) {
        var urls = (all && all[post.id]) || [];
        tryRemote(0);
        function tryRemote(i) {
          if (i >= urls.length) {
            cov.classList.add('is-frame');
            cov.innerHTML = frameHTML(post.workTitle, post.type);
            return;
          }
          var probe = new Image();
          probe.onload = function () {
            img.src = urls[i];
            img.classList.add('is-loaded');
            img.onerror = null;
          };
          probe.onerror = function () { tryRemote(i + 1); };
          probe.src = urls[i];
        }
      });
    };
    img.src = 'covers/' + encId(post.id) + '.jpg';
    cov.appendChild(img);
  }

  /* ---------- 入场动效 ---------- */

  function reveal(scope) {
    var els = scope.querySelectorAll('.fade-in:not(.in)');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    els.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i * 35, 400) + 'ms';
      io.observe(el);
    });
  }

  /* ---------- 首页：封面墙 ---------- */

  function initWall() {
    fetch('posts/index.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(render)
      .catch(function () {
        document.getElementById('wall').innerHTML =
          '<div class="empty">内容尚未生成：请先运行 node scripts/build.mjs</div>';
      });

    function render(posts) {
      var counts = { all: posts.length };
      TYPE_ORDER.forEach(function (t) {
        counts[t] = posts.filter(function (p) { return p.type === t; }).length;
      });

      var bar = document.getElementById('filters');
      var types = ['all'].concat(TYPE_ORDER.filter(function (t) { return counts[t] > 0; }));
      bar.innerHTML = types.map(function (t) {
        return '<button type="button" data-type="' + t + '">' +
          (t === 'all' ? '全部' : LABELS[t]) + '<i>' + counts[t] + '</i></button>';
      }).join('');

      var apply = function (t) {
        if (t !== 'all' && !counts[t]) t = 'all';
        history.replaceState(null, '', t === 'all' ? ' ' : '#' + t);
        bar.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', b.dataset.type === t);
        });
        paint(posts.filter(function (p) { return t === 'all' || p.type === t; }));
      };
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-type]');
        if (b) apply(b.dataset.type);
      });
      var h = location.hash.replace('#', '');
      apply(TYPE_ORDER.indexOf(h) > -1 ? h : 'all');
    }

    function paint(list) {
      var wall = document.getElementById('wall');
      if (!list.length) {
        wall.innerHTML = '<div class="empty">暂无文章</div>';
        return;
      }
      wall.innerHTML = list.map(function (p) {
        return '<a class="card fade-in" href="post.html?id=' + encId(p.id) + '">' +
          '<div class="cov"></div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p class="meta">' + (LABELS[p.type] || '专题') + ' · 约 ' + p.minutes + ' 分钟</p>' +
          '</a>';
      }).join('');
      wall.querySelectorAll('.card').forEach(function (card, i) {
        mountCover(card.querySelector('.cov'), list[i]);
      });
      reveal(wall);
    }
  }

  /* ---------- 文章页 ---------- */

  function initArticle() {
    var id = new URLSearchParams(location.search).get('id');
    var box = document.getElementById('article');

    Promise.all([
      fetch('posts/' + encId(id || '') + '.json').then(function (r) {
        if (!r.ok) throw new Error('not found');
        return r.json();
      }),
      fetch('posts/index.json', { cache: 'no-cache' }).then(function (r) {
        return r.ok ? r.json() : [];
      }).catch(function () { return []; })
    ]).then(function (res) {
      var post = res[0], index = res[1];

      document.title = post.title + ' · 张二的上下文';
      var i = index.findIndex(function (p) { return p.id === post.id; });
      var prev = i > 0 ? index[i - 1] : null;
      var next = i > -1 && i < index.length - 1 ? index[i + 1] : null;

      box.innerHTML =
        '<p class="a-meta fade-in">' + (LABELS[post.type] || '专题') + ' · 约 ' + post.minutes + ' 分钟</p>' +
        '<h1 class="a-title fade-in">' + esc(post.title) + '</h1>' +
        (post.byline ? '<p class="a-byline fade-in">' + esc(post.byline) + '</p>' : '') +
        '<div class="a-cover fade-in"><div class="cov"></div></div>' +
        '<div class="prose fade-in">' + post.content + '</div>' +
        '<nav class="a-nav fade-in">' +
          (prev ? '<a href="post.html?id=' + encId(prev.id) + '">← ' + esc(prev.title) + '</a>' : '<span></span>') +
          (next ? '<a href="post.html?id=' + encId(next.id) + '">' + esc(next.title) + ' →</a>' : '<span>已是最后一篇</span>') +
        '</nav>';

      mountCover(box.querySelector('.a-cover .cov'), post);
      reveal(box);
    }).catch(function () {
      document.title = '未寻得此文 · 张二的上下文';
      box.innerHTML = '<div class="a-empty">未寻得此文——它也许尚未写就' +
        '<a href="./">← 返回目录</a></div>';
    });
  }

  /* ---------- 启动 ---------- */

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('year').textContent = new Date().getFullYear();
    if (document.getElementById('wall')) initWall();
    else initArticle();
  });
})();
