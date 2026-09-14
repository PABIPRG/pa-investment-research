# 投研智能体官网

可独立部署的静态官网，无 npm 依赖。包含首页、粒子交互、明暗主题、自动年份、产品问答与基础 SEO。业务应用与此目录分开部署。

## Vercel

- Root Directory：`frontend/official-site`（若单独上传本目录，则选项目根目录）。
- Framework Preset：Other。
- Build Command：`node build.mjs`。
- Output Directory：`dist`。
- 安装步骤由 vercel.json 跳过，不需要安装 frontend 工作区依赖。
- 环境变量在 Vercel 项目 Settings → Environment Variables 中配置，修改后重新部署。

| 环境变量 | 用途 | 为空时 |
|---|---|---|
| SITE_URL | 官网正式 HTTPS 根域名，用于 canonical、sitemap、分享地址 | 生产构建失败；预览可用 |
| WEB_APP_URL | “进入网页版”按钮的 HTTPS 跳转地址，可带路径 | 顶部和页脚显示“敬请期待”，点击不跳转 |
| VERCEL_ENV | Vercel 自动注入的环境标识 | 非 production 默认 noindex |

WEB_APP_URL 在构建时写入 HTML，因此是公开网址，不要填含凭证的地址。配置后两个入口均通过 JavaScript 跳转到该地址。SITE_URL 与 WEB_APP_URL 可以属于不同域名。

## 本地

Node.js 22 或更高版本，零第三方依赖：

```sh
node build.mjs
# 使用本地环境文件（先复制 .env.example 为 .env 并填写）
node --env-file=.env build.mjs
# 验证构建与环境变量分支
node verify.mjs
```

部署仅上传 dist；不要将整个目录设为静态输出目录。源码 index.html 是未注入环境变量的预览模板，以 dist/index.html 为部署结果。

## 目录

- index.html、style.css、motion.js、app-icon.png：官网源码及资源。
- build.mjs、vercel.json：构建与部署配置。
- design/：设计拆解、历史深色参考与修改记录，不参与发布。记录中的旧预览路径仅为历史证据。
- DEPLOY-SEO.md：SEO/GEO 检查与上线后待验证项。

尚未部署；投研业务入口仅在配置 WEB_APP_URL 后跳转。历史 dark-reference 不代表当前官网功能。
