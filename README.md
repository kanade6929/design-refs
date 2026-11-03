# 设计参考库

暗色静态图库，用浏览器打开即可浏览。页面直接读取仓库根目录的 `index.csv`，不需要构建。图片按表格从上到下排列。

线上地址：<https://kanade6929.github.io/design-refs/>

## 机器人如何加图

1. 把文件放到 `分类/子分类/`。文件名用 `YYYY-MM-DD_简述.扩展名`，例如 `周边设计/亚克力/2026-11-03_示例立牌.jpg`。
2. 在 `index.csv` **末尾追加一行**，不要改表头。列依次是 `path,category,tags,source,note,saved`。
   - `path`：相对仓库根目录，必须和文件位置一致
   - `category`：`分类/子分类`（没有子分类就只写分类）
   - `tags`：多个标签用 `|` 分隔
   - `source`：来源网址，可以留空
   - `note`：备注。内容里有英文逗号、引号或换行时，整段用双引号包起来，引号本身写成 `""`
   - `saved`：`YYYY-MM-DD`
3. 还没有图片、但希望出现在分类栏里的分类，写进 `categories.json`。已经有图片的分类会从 `index.csv` 自动出现。
4. 推送到 `main`。GitHub Actions 会发布到 GitHub Pages。

## 在网页里改（手机或电脑）

没有令牌时只能浏览，编辑按钮不会出现。令牌只保存在这台设备的 localStorage，不会写进仓库。

创建细粒度令牌：

1. 打开 [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)，Generate new token。
2. Token name 可填「design-refs 图库」。Resource owner 选 **kanade6929**。
3. Repository access 选 **Only select repositories**，只勾选 **design-refs**。
4. Permissions → Repository permissions → **Contents** 设为 **Read and write**。其他权限保持 No access。
5. Generate token，复制 `github_pat_` 开头的令牌。
6. 在图库页眉点锁图标，粘贴一次并保存。

保存之后可以：点右下角 **+** 或把图片拖进页面上传（可多张，接着填分类、标题、标签、备注、来源）；在卡片上编辑标签和备注、移动分类、删除；在大图里直接改标签；在分类栏用 **+** 新增分类或子分类，或删除分类。删除前都会再确认。分类里还有图片时，可以选择移到别处，或连图片一起删除。

新文件会存成 `YYYY-MM-DD_简述.扩展名`。每次保存都是一次提交，同时更新 `index.csv`（需要时还有 `categories.json` 和图片文件），其他机器人仍以 `index.csv` 为准。

不再使用时，在 GitHub 的令牌页面撤销它，并在锁图标里清除本机保存的令牌。

## 发布

推送到 `main` 后，`.github/workflows/pages.yml` 用 `actions/deploy-pages` 部署。

如果 Actions 报错说还没有 Pages 站点：打开仓库 **Settings → Pages → Build and deployment**，**Source** 选 **GitHub Actions**。
