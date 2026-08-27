# 投研产品设计规范

## 字体基线

- Web 与 Electron 必须共用同一套字体规则和组件样式，不得针对某一端单独覆盖字号。
- `html` 根字号固定为 `14px`。这是字号体系中唯一允许使用 `px` 的位置。
- 组件内的 `font-size` 必须使用 `rem`；正文以 `1rem` 为基准，标题、辅助文字和状态文字按语义相对缩放。
- 推荐字号层级：辅助说明 `0.7143rem`、次要正文 `0.8571rem`、正文 `1rem`、小标题 `1.1429rem`、页面标题 `1.5714rem`。
- 正文行高优先使用无单位倍率；需要与输入控件精确对齐时可以使用 `rem`。
- 表单控件必须继承页面字体和字号，避免浏览器默认样式造成输入框与周边文字不一致。

## 助理浮层

- AI 研究助理覆盖在业务页面上方，不改变业务页面宽度。
- 输入框正文使用 `1rem`，工具栏文字使用 `0.8571rem`，避免输入内容比业务正文明显偏大。
- 工具选择器仅保留有意义的文字与展开箭头，不使用无语义装饰图标。
- 新对话属于主操作，使用主色按钮；历史属于次操作，使用有边界和底色的次级按钮。
- 历史对话抽屉及遮罩必须限制在助理浮层内部，不得覆盖完整业务页面或与助理边框形成双层冲突。

## 实施检查

- 修改字体相关样式时，同时检查 Web 与 Electron。
- 新增组件样式不得写入 `px` 字号；检查应覆盖 CSS Modules 和全局基础样式。
- 在 1024px 与 1440px 两种典型宽度下检查标题、正文、输入框、工具栏和抽屉层级。

---
name: Technical Precision
colors:
  surface: '#f8f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f8f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#434653'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#737785'
  outline-variant: '#c3c6d5'
  surface-tint: '#1758c7'
  primary: '#1155c4'
  on-primary: '#ffffff'
  primary-container: '#396fdf'
  on-primary-container: '#fefcff'
  inverse-primary: '#b1c5ff'
  secondary: '#5d5e63'
  on-secondary: '#ffffff'
  secondary-container: '#e2e2e8'
  on-secondary-container: '#636469'
  tertiary: '#575c61'
  on-tertiary: '#ffffff'
  tertiary-container: '#70757a'
  on-tertiary-container: '#fcfcff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2ff'
  primary-fixed-dim: '#b1c5ff'
  on-primary-fixed: '#001946'
  on-primary-fixed-variant: '#00419e'
  secondary-fixed: '#e2e2e8'
  secondary-fixed-dim: '#c6c6cc'
  on-secondary-fixed: '#1a1c20'
  on-secondary-fixed-variant: '#45474b'
  tertiary-fixed: '#dee3e9'
  tertiary-fixed-dim: '#c2c7cc'
  on-tertiary-fixed: '#171c20'
  on-tertiary-fixed-variant: '#42474c'
  background: '#f8f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  html:
    fontSize: 14px
  display-lg:
    fontFamily: Inter
    fontSize: 1.5714rem
    fontWeight: '700'
    lineHeight: 1.5
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Inter
    fontSize: 1.1429rem
    fontWeight: '700'
    lineHeight: 1.5
    letterSpacing: -0.005em
  headline-md:
    fontFamily: Inter
    fontSize: 1.1429rem
    fontWeight: '600'
    lineHeight: 1.5
  body-base:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5
  ui-medium:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '500'
    lineHeight: 1.5
  ui-base:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5
  ui-compact:
    fontFamily: Inter
    fontSize: 0.8571rem
    fontWeight: '400'
    lineHeight: 1.5
  label-sm-strong:
    fontFamily: Inter
    fontSize: 0.8571rem
    fontWeight: '500'
    lineHeight: 1.5
  caption:
    fontFamily: Inter
    fontSize: 0.7143rem
    fontWeight: '400'
    lineHeight: 1.5
  code-base:
    fontFamily: JetBrains Mono
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.8571rem
    fontWeight: '400'
    lineHeight: 1.5
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  chat-max-width: 748px
  composer-max-width: 780px
---

## Brand & Style

The visual identity is defined by a clean, technical, and developer-focused aesthetic. It prioritizes information density, structural discipline, and computational rigor, specifically tailored for AI-centric orchestration and high-productivity workflows.

The design style is **Corporate / Modern** with a lean towards **Minimalism**. It uses a cool-toned palette to create a "technical canvas" feel. Hierarchy is established through subtle tonal layering and hairline borders rather than heavy shadows or decorative elements. The interface should feel like a sophisticated IDE or a high-end developer tool—precise, reliable, and unobtrusive.

**Key Principles:**
- **Clarity over Decoration:** Every element serves a functional purpose in navigating complex AI data.
- **Structural Discipline:** Rigid adherence to a 4px grid system and consistent radii.
- **Cool-Toned Environment:** Utilization of bluish-neutrals to reduce eye strain during long sessions.

## Colors

The palette is anchored by "DeepSeek Electric Blue" for primary interactions and a sophisticated range of cool grays and slates for structural elements.

- **Primary (`#4176e6`):** Used for primary CTAs, active states, and focus indicators.
- **Surface & Backgrounds:** Use `#ffffff` for the main content canvas and `#f9fafb` for secondary surfaces like sidebars to create a subtle but clear distinction between navigation and workspace.
- **Typography:** Use `#0f1115` for high-emphasis headers and `#61666b` for secondary body text to maintain a professional, high-contrast reading experience.
- **Borders:** Utilize semi-transparent outlines (`rgba(0, 0, 0, 0.10)`) to define containers without adding visual weight.
- **Semantic Colors:** Success, Warning, and Error colors follow standard utility conventions but are calibrated for legibility against both white and off-white surfaces.

## Typography

The typography system is built on **Inter** for its neutral, systematic character and exceptional legibility in data-dense interfaces. **JetBrains Mono** is used for all technical and AI-generated code content.

**Usage Guidelines:**
- **Hierarchy:** Use weight changes (400 to 700) rather than drastic size changes to indicate hierarchy.
- **Density:** For Kanban boards and complex tables, prefer `ui-compact` (`0.8571rem`) to maximize visible information.
- **Code:** All assistant-generated outputs, terminal snippets, and variable names must use the code stack to signal "machine-readable" data.
- **Line Height:** Maintain tight but readable line heights (approx 1.4x - 1.5x) to ensure text blocks remain cohesive within compact UI components.

## Layout & Spacing

This system utilizes a **Fixed Grid** approach for core application workflows to ensure predictability in tool-heavy interfaces.

- **Grid Model:** A 12-column system is used for dashboard views, while a centered single-column layout is preferred for the AI chat experience.
- **Rhythm:** All spacing must be a multiple of the 4px base unit.
- **Chat Layout:** The message transcript is locked to a `748px` width to maintain optimal line lengths for reading. The input composer is slightly wider at `780px` to visually anchor the bottom of the viewport.
- **Kanban Layout:** Column widths should be consistent (e.g., 280px - 320px) with 16px gutters.
- **Breakpoints:**
  - **Desktop:** Sidebar is expanded (260px).
  - **Tablet:** Sidebar collapses to a 56px icon rail.
  - **Mobile:** Sidebar moves to a hidden drawer; horizontal padding reduces to 16px.

## Elevation & Depth

Hierarchy is established through **Tonal Layers** and **Low-contrast Outlines** rather than physical depth.

- **Surface Levels:**
  - **Level 0 (Canvas):** Pure white background for the primary workspace.
  - **Level 1 (Sidebars/Panels):** `#f9fafb` with a 1px hairline border.
  - **Level 2 (Cards/Modals):** Elevated using a very soft shadow (`0 4px 12px rgba(0,0,0,0.04)`) and a `1px` border of `rgba(0,0,0,0.10)`.
- **Separators:** Use 1px hairlines for all divisions. Avoid thick borders.
- **Interactivity:** Hover states are indicated by a subtle background tint (`rgba(0, 0, 0, 0.04)`) rather than shadow changes.

## Shapes

The shape language is **Rounded**, striking a balance between a modern approachable feel and professional precision.

- **Standard Elements (Buttons, Inputs):** Use `0.5rem` (8px) for a consistent UI feel.
- **Large Containers (Cards, Composer):** Use `rounded-xl` (1.5rem / 24px) to create a distinct containerized look for major interface blocks.
- **Status Pills/Tags:** Use "Full" roundedness (capsule) to distinguish metadata from interactive buttons.
- **Technical Blocks (Code):** Use a slightly tighter `0.75rem` (12px) radius for code snippets to maximize internal space.

## Components

### Buttons
- **Primary:** Capsule-shaped with `#4176e6` background and white text.
- **Ghost:** Transparent background with a `1px` border of `rgba(0, 0, 0, 0.10)`. Used for secondary actions in toolbars.
- **Size:** Standard height is 36px; compact height is 28px for use within cards.

### Kanban Cards
- **Structure:** 12px corner radius, white background, hairline border.
- **Header:** `ui-compact` bold text with a status indicator (dot or icon) in the top-right.
- **Metadata:** Use `label-sm-strong` (`0.8571rem`) for timestamps and user tags.

### Chat Interface
- **User Bubbles:** Right-aligned, `#edf3fe` background, 22px corner radius.
- **Assistant Messages:** Left-aligned, no background bubble, pure typography on the canvas to emphasize the "agent" presence.
- **Composer:** A 24px rounded card containing a borderless auto-expanding textarea and a primary send button.

### Inputs & Fields
- **Fields:** 8px corner radius, 1px border. The border color transitions to the primary blue (`#4176e6`) on focus with no heavy outer glow.
- **Chips:** Capsule-shaped, `#f1f3f5` background, `label-sm-strong` (`0.8571rem`) medium text.

### Interactive Elements
- **Tabs:** Horizontal layout with a 2px blue underline to indicate the active state. No background fills on tabs.
- **Checkboxes:** 4px rounded corners, primary blue fill when checked.

## 投研业务交互补充

- 历史对话属于投研助理内部视图。小窗状态打开历史时应完整覆盖助理内容区，不保留窄遮罩条；放大状态可使用右侧抽屉与轻遮罩。会话条目的悬停、聚焦和选中反馈作用于整行，更多操作只作为行内次级入口。
- 个股详情需要同时承接“加入自选”“加入持仓”“带入智能分析”三类去向。加入持仓必须先录入数量与成本并明确确认；加入自选需同步实时盯盘与个性化研究，部分同步失败必须如实提示。
- “我的投研”是持仓、自选和画像事实的稳定入口。自选股以股票名称为主、代码为辅，并提供查看个股详情和移出操作。
- 自进化按“影子数据 → 策略归因 → 只读预案 → 人工确认”展示连续状态。分策略证据以股票名称和代码为主，不用策略 ID 作为用户主标题；可识别证券时整行可进入个股详情。
- 数据列表和卡片保持信息密度，但主标题、辅助指标、状态标签与操作按钮必须分层清晰。空数据保留下一步动作，`null` 统一显示为“—”，不补造为 `0`。
