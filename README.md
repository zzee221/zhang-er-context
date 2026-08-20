# 张二的上下文

书评、影评与专题文章的个人站点。杂志编辑风：思源宋体、大留白、克莱因蓝点缀、封面墙目录。

## 工作方式

```
《作品名》.md  ──►  node scripts/build.mjs  ──►  posts/*.json + covers/*.jpg  ──►  纯静态站点
     ▲                    │
     │                    ├─ 分类：data/meta.json 覆盖 → 豆瓣书/影接口自动识别
     │                    └─ 封面：手动指定 → 豆瓣 → Google Books / TMDB → 文字题图
     └─ 你只需要往根目录丢 markdown 文件，其余全自动
```

## 添加一篇文章

1. 在根目录新建 `《作品名》.md`，正文格式随意：首行 `# 标题`，段落空行分隔
2. 文中单独一行长破折号（`——————`）会渲染成分界线；破折号后跟的说明文字保留为小注
3. `git push` 即可——Netlify 会自动构建部署

**不用写日期**：站点不显示日期；排序默认按文件名。

## 分类规则

构建时按豆瓣书库/影库自动识别（书名在哪个库命中就是哪类，书影同名时按正文关键词投票，
单边命中但正文强烈反向时以正文为准）。识别错了或查不到时，在 [data/meta.json](data/meta.json) 加一行：

```json
"《作品名》": { "type": "movie" }
```

- `type` 可选 `book` / `movie` / `essay`（专题，固定用文字题图）
- `aka`：作品在豆瓣的正式译名。比如《离线找真爱》在豆瓣叫《线下恋爱》，
  直接搜是搜不到的，写 `"aka": "线下恋爱"` 即可
- `byline`：文章页的作品信息行（不写则自动用豆瓣的作者/年份拼出）

每次构建的部署日志会打印全部文章的分类结果与封面来源，方便抽查。

## 封面规则

按优先级取第一个成功者：

1. `data/meta.json` 里 `"cover": "图片网址"` 手动指定
2. `covers/{文件名}.jpg` —— 手动放一张同名图，永久覆盖自动结果
3. 豆瓣（构建时下载到站内，绕过防盗链）
4. Google Books（书）/ TMDB（影，需设 `TMDB_KEY` 环境变量）
5. 文字题图（白底细线框 + 大字标题，与专题同款，观感是有意为之）

下载成功的封面会留在 `covers/` 并随仓库提交（总共约 7MB），因此日常部署
不会重新请求豆瓣，也不怕豆瓣封锁境外构建服务器。`.build-cache.json`
（豆瓣解析缓存）同样随仓库提交：新增文章后本地跑一次 `node scripts/build.mjs`
再 push，就能把新条目的解析结果固化进缓存。

## 本地预览

```bash
node scripts/build.mjs          # 生成 posts/ 与 covers/（首次约 2 分钟）
python3 -m http.server 8080     # 打开 http://localhost:8080
```

## 部署到 Netlify

1. 整个目录推到 GitHub 仓库（`posts/` 已在 .gitignore 中，无需提交；
   `covers/` 与 `.build-cache.json` 要提交，见上文「封面规则」）
2. [Netlify](https://app.netlify.com/) → Add new site → Import from Git → 选中仓库
3. 构建命令与发布目录已写在 [netlify.toml](netlify.toml)，直接 Deploy
4. 之后每次 push 自动重新构建（用 Netlify 自己的免费构建额度，不占用 GitHub Actions）

可选：Netlify 站点设置里加环境变量 `TMDB_KEY`（[免费申请](https://www.themoviedb.org/settings/api)），
可显著提升冷门电影的封面命中率。

## 目录结构

```
index.html / post.html     页面壳
assets/style.css           全站样式（杂志极简风）
assets/app.js              前端渲染
data/config.js             站名等基础配置
data/meta.json             分类/封面/信息行的手动覆盖 ← 唯一需要编辑的配置
scripts/build.mjs          构建脚本
《xx》.md                   你的文章（根目录）
posts/ · covers/           构建产物（自动生成）
```
