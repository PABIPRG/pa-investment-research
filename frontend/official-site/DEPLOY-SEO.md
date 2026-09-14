# Vercel 部署与 SEO / GEO 检查

范围：2026-09-14，本地首页交互预览，不是已上线网站审计。当前没有正式域名、Search Console 或访问数据，收录、流量及 AI 引用均不可判断，不评分。

## 已完成

- 年份：构建及浏览器加载时读取当前年份，页面停留时每分钟检查，切回标签页也更新。
- 静态 HTML 正文、中文 title/description、Open Graph、WebApplication JSON-LD、图标。
- 增加可展开的真实产品问答，明确产品用途、信息核验边界和网页版状态。没有虚构评分、价格或客户案例。
- 无 JavaScript 时正文区仍可展示；动态粒子为装饰，不承载唯一正文。
- 构建生成唯一首页 index.html、robots.txt，生产环境生成绝对 canonical、og:url、图标分享地址、sitemap.xml。
- 预览输出 noindex，robots 允许抓取以便搜索引擎读取 noindex。此设置不提供访问保密。

## 部署步骤

1. 将 frontend/official-site 作为 Vercel 项目的根目录，框架选 Other。已有 vercel.json：Build Command 为 node build.mjs，Output Directory 为 dist，无第三方依赖。
2. 在 Vercel 生产环境配置 SITE_URL，值为正式 HTTPS 根域名，例如 https://你的域名；不要填写路径。VERCEL_ENV 由 Vercel 注入。没有 SITE_URL 时生产构建会失败，避免发布错误 canonical。
3. 绑定域名后生产部署。通过 WEB_APP_URL 配置网页版业务入口，留空时点击不跳转，此包只包含介绍首页，不包含投研后台、账户系统或业务服务。入口通过构建注入 WEB_APP_URL，由 JavaScript 判断是否跳转。
4. 发布后检查首页 200、robots.txt、sitemap.xml、canonical 与分享预览，向搜索平台提交 sitemap。核验 Vercel Deployment Protection 和抓取规则是否符合公开站点目标。

仅 dist 中的首页和资源被发布，design/ 下的 study.md、revision-notes.md、dark-reference 不进入输出目录。不要将整个设计目录直接当作静态输出目录。

## 三项后续优先级

1. P0 正式域名与公开访问：设置 SITE_URL，实际上线后验证抓取与提交 sitemap；当前只能验证构建输出。
2. P1 可信内容：补真实使用文档、功能案例、来源说明和更新日期，确认业务入口。GEO 依赖清晰且有依据的内容，不能保证引用。暂不为 AI 搜索批量堆关键词或生成无依据页面。
3. P2 实测性能与分享：上线后测移动端 Core Web Vitals，重点观察粒子 WebGL 与持续动效；制作正式横版分享图。目前分享资源复用产品图标，未做专用海报。

## 验证与限制

通过：JS 语法、预览构建、带测试域名的生产构建、缺少域名的失败分支、预览 noindex、测试域名清理、浏览器当前年份、JSON-LD 解析、FAQ 展开与825×889排版；Vercel 官方 schema 字段校验；两个入口的空地址与配置地址 JS 跳转检查；部署文件白名单；生产产物在439px实际打开，WebGL 正常、无横向溢出、控制台无错误。
未验证：真实跨年时钟、Vercel 云端部署、线上状态码、Google/Bing 收录、AI 引用、Lighthouse/CWV、无 JS 浏览器实测。当前未发布。

参考官方文档：
- https://developers.google.com/search/docs/appearance/ai-features
- https://vercel.com/docs/project-configuration/vercel-json
