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
# 方向累计、焦点、回弹与布局重算
node --test scroll-header.test.mjs
```

部署仅上传 dist；不要将整个目录设为静态输出目录。源码 index.html 是未注入环境变量的预览模板，以 dist/index.html 为部署结果。

## 目录

- index.html、style.css、motion.js、scroll-header.mjs、app-icon.png：官网源码及资源。
- build.mjs、vercel.json：构建与部署配置。
- design/：设计拆解、历史深色参考与修改记录，不参与发布。记录中的旧预览路径仅为历史证据。
- DEPLOY-SEO.md：SEO/GEO 检查与上线后待验证项。

尚未部署；投研业务入口仅在配置 WEB_APP_URL 后跳转。历史 dark-reference 不代表当前官网功能。

## 方向感知导航

首屏内保持显示；离开实际首屏底部后，同向累计下滚 24px 隐藏、上滚 12px 显示。固定层使用 0.36 秒 transform 过渡，不改变正文布局。导航键盘焦点（:focus-visible）强制显示，鼠标点击后的残留焦点不阻止下滚隐藏；主题按钮保留原高度，入口按钮与其对齐（桌面实测 40.5px、窄屏 40px）。键盘焦点，减少动态模式持续显示且无过渡。无 JavaScript 时保留原非吸顶导航。锚点偏移随导航高度更新，研究流程固定段为导航预留空间。

导航沿用全宽与 blur 3px；首屏使用浅色 10% / 深色 14% 背景，导航下缘覆盖正文时两种主题均改为 96% 不透明度，保证跨区段可读性。全站主题由原主题按钮管理。实际验收与可读性限制见 [方向导航验收记录](design/scroll-header-uat.md)。

## 研究助理展示

研究助理采用研究视角选择与问题札记布局，三项切换复用原示例内容和键盘方向键操作。标题、问题与输出分层呈现，标注非实时分析；移除语音波形装饰，窄屏改为上方三列选择、下方正文。
