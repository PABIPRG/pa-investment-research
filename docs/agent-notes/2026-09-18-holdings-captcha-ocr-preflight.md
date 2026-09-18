# Agent Note：券商持仓读取的验证码 OCR 前置提醒

Status: implemented

## 问题

`easytrader` 读取同花顺持仓时会给网格下发复制命令，券商风控可能弹出验证码，由 `pytesseract` 调 `tesseract` 识别。Windows 版 Tesseract 安装器**默认不写 PATH**，所以用户机器上装了也照样失败。

上一个变更（提交 `ec190fc6`）把失败文案从误导性的「请确认客户端已登录且窗口未被遮挡」改成指向 OCR——修的是「说人话」，没修「什么时机说」。原来的时机是最坏的：用户点读取 → 客户端弹验证码抢走焦点 → 才报错，此时用户已经离开了应用，错误提示也没有出现在他看得到的地方。

## 决策

- 新增 `_ocr.find_tesseract()`：只找路径，不 import `pytesseract`、不写任何全局状态。原 `locate_tesseract()` 拆成「纯查找 + 设置 `tesseract_cmd`」两段，行为不变。
  - 拆分是必需的：快照接口是只读探测路径（`holdings_source.py` 模块约定「只报告不抛错」），一个会改全局状态的探测不能放在那里。现有 4 个 `locate_tesseract` 测试零改动通过，这是「重构无行为变化」的证明。
- 新增 `_ocr.tesseract_status()`（`'available' | 'missing'`）和 `_ocr.missing_tesseract_notice()`（预告式文案，区别于失败后解释的 `missing_tesseract_hint()`）。
- `provider_snapshot()` 新增两个**建议性字段**：`captcha_ocr`（`available | missing | unknown | not_applicable`）与 `captcha_ocr_hint`。取值沿用现有单名词 + `not_applicable` 惯例（`installation` / `process` / `accessibility` / `navigation` / `automation` / `session` 都是这个形状），只在 `easytrader` 分支改写，其余 provider 靠初始字面量自动正确。
- **OCR 缺失不置 `available=False`、不禁用读取按钮、不复用 `dependency_missing`。** 这是本变更的核心约束。`easytrader.py` 已注明验证码不是每次必弹，没装 OCR 的机器读不弹验证码的持仓完全正常；复用致命码有两重错——既禁掉一个经常可用的功能，又暗示「重装本应用」，而 Tesseract 是用户自己装的三方软件。
- 探测块放在 `easytrader` 分支的**第一条语句**，在三个 `return blocked(...)`（`client_location_required` / `dependency_missing` / `client_not_running`）之前。客户端没开、没选路径时也要带着提示返回，由前端按 `ready` 决定显不显示。
- 文案归属后端：`captcha_ocr_hint` 由 Python 产生，前端只渲染。前端没有任何 code→文案映射，也没有 i18n 层。更关键的是「Windows 安装包默认不写 PATH、本应用会自动探测常见安装目录」这句是关于 `_ocr.py` 自身探测策略的事实，写进 TSX 就会和实现分家——下次谁加一个候选目录，只会改 `_ocr.py`，永远看不到 TSX 那份。
- 前端复用现成的 `css.syncReadinessNotice`（warn 色盒子，当前唯一使用者是 macOS 分支，与本分支互斥），不新建组件、不新建 token、不改 CSS。渲染条件 `native !== undefined && platform !== 'darwin' && ready && preview === undefined` 保证它与阻塞原因、权限引导**互斥**——同一屏最多一条原因。读取失败后 `ready` 变假，提示自动消失，失败态由既有 banner 承载，不需要清状态。
- 不加 `sys.platform == "win32"` 判断：`platform_gate` 在非 Windows 上已经拦住 `easytrader`，加了只会造出一个只有被 patch 才能走到的分支。

## 备选方案

- **复用 `dependency_missing` 阻断读取**：文案现成、前端已有渲染分支，但会禁用一个经常可用的功能，且修复动作指向错误（重装本应用 ≠ 装 Tesseract）。否决。
- **把文案写在 TSX 里**：省一次后端改动，但会让 `_ocr.py` 的探测策略在多处失真，且与「限制说明都来自 Python」的既有链路不一致。否决。
- **新建一个提示组件或新 token**：违反仓库「先审计再复用」的要求，视觉上也会和 macOS 分支那条同类提示分叉。否决。
- **在 `native_read` 失败时补一条提示**：这正是现状，用户已经离开应用才看到错误。否决。

## 结果与边界

- 缺失时 `available is True`、`blocking_reason is None`、`"read" in available_actions`——核心非回归已由 `CaptchaOcrAdvisoryTests` 固定，并覆盖「客户端没开也要带提示返回」这条会在探测放错位置时失败的用例；探测抛异常降级为 `unknown` 且快照不炸；非 OCR provider 为 `not_applicable`。
- 真机验收（Electron 桌面端 + 真实同花顺客户端已运行）：1440 / 1024、浅色 + 深色四种组合下提示均正确渲染，warn 色 token 在两种主题下都生效，1024 无横向溢出；键盘 Tab 3 次可到达「我已打开，开始读取」，按钮未禁用；正常环境跑同一屏确认提示不出现（`[role=note]` 数量为 0），后端 `captcha_ocr="available"`、hint 为 `None`。证据见 `docs/superpowers/handoffs/assets/2026-09-18-holdings-ocr-preflight/`。
- 验收中意外触发过一次真实读取（键盘走位），拿到了失败态的真机渲染，证实「同屏不会出现两条原因」：失败后提示盒与读取按钮一起消失，只剩失败 banner。同时该截图坐实了下一条局限——OCR 失败在 Windows 上被渲染成 macOS 的「补充自动化授权 / 打开自动化设置」。
- **探测只覆盖 tesseract 二进制**。`pytesseract` 本身不可导入是第二个真实故障模式（它并不是 `easytrader==0.23.7` 的声明依赖），但修复动作不同（「本应用依赖不完整」vs「去装 Tesseract」），需要更细的取值，与本次范围一致地另开 issue。
- **读取时 OCR 失败仍走既有错误码路径**：OCR 真失败时抛出的异常目前被归为 `automation_required`，前端据此渲染 macOS 味道的「打开自动化设置」引导。这是本次改动之前就存在的问题（`ec190fc6` 之前就有），本次只做前置提醒、不碰失败态分类，修它属于另一件事。
- 字段是纯增量的：老前端遇到新后端只是多一个不认识的 key，新前端遇到老后端 `text(undefined, '') === 'missing'` 为假，不显示提示。
