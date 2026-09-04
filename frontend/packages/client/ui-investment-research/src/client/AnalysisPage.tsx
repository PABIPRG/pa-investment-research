import { useMemo, useState } from 'react'
import type { AssistantIntent } from './assistant-intent.ts'
import {
  ANALYSIS_MODULES,
  type AnalysisModuleDefinition,
  type AnalysisTaskKind,
} from './analysis-modules.ts'
import { DetailDialog } from './DetailDialogs.tsx'
import css from './InvestmentShell.module.css'

function ModuleHeader({ definition }: { readonly definition: AnalysisModuleDefinition }) {
  return (
    <div className={css.analysisModuleHeader}>
      <div>
        <span>{definition.eyebrow}</span>
        <h2>{definition.title}</h2>
        <p>{definition.summary}</p>
      </div>
    </div>
  )
}

/** Properties for the rc.10 analysis capability overview. */
export interface SmartAnalysisPageProps {
  readonly onOpenReports: () => void
  readonly onOpenAssistant: (intent: AssistantIntent) => void
}

/** Presents research capabilities and hands execution off to the AI assistant. */
export function SmartAnalysisPage({ onOpenReports, onOpenAssistant }: SmartAnalysisPageProps) {
  const [detailId, setDetailId] = useState<AnalysisTaskKind>()
  const selectedDefinition = useMemo(
    () => ANALYSIS_MODULES.find(module => module.id === detailId),
    [detailId],
  )
  const openModule = (definition: AnalysisModuleDefinition): void => {
    setDetailId(undefined)
    onOpenAssistant({
      kind: 'prompt', prompt: definition.promptTemplate, promptTemplateId: definition.id,
    })
  }

  return (
    <div className={`${css.pageScroll} ${css.primaryRouteSurface}`} data-testid="analysis-workbench">
      <div className={css.pageHeader}>
        <div>
          <h1>智能分析</h1>
          <p>了解研究能力，并在 AI 研究助理中用自然语言启动和推进研究</p>
        </div>
        <div>
          <button type="button" className={css.secondaryButton} onClick={onOpenReports}>查看全部投研报告</button>
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => {
              onOpenAssistant({ kind: 'prompt', prompt: '', promptTemplateId: 'general' })
            }}
          >打开 AI 研究助理</button>
        </div>
      </div>

      <section className={css.analysisOverview} aria-labelledby="analysis-overview-title">
        <div><span>研究能力</span><strong id="analysis-overview-title">4 类</strong><small>个股、持仓、简报、历史复盘</small></div>
        <div><span>专家协作</span><strong>17 个角色</strong><small>按任务读取资料，不在输入框传 JSON</small></div>
        <div><span>结果归档</span><strong>投研报告</strong><small>研究结果统一沉淀并可再次打开</small></div>
        <div><span>执行边界</span><strong>研究支持</strong><small>不触发真实交易</small></div>
      </section>

      <div className={css.analysisModuleGrid}>
        {ANALYSIS_MODULES.map(definition => (
          <article key={definition.id} className={css.analysisModuleCard} data-analysis-module-id={definition.id}>
            <ModuleHeader definition={definition} />
            <div className={css.detailTags} aria-label={`${definition.title}产出`}>
              {definition.outputs.slice(0, 3).map(output => <span key={output}>{output}</span>)}
            </div>
            <div className={css.analysisCardActions}>
              <button
                type="button"
                className={css.secondaryButton}
                aria-haspopup="dialog"
                onClick={() => { setDetailId(definition.id) }}
              >查看模块详情</button>
              <button
                type="button"
                className={css.primaryButton}
                data-action="analysis-module-chat"
                data-analysis-module-id={definition.id}
                onClick={() => { openModule(definition) }}
              >打开助理</button>
            </div>
          </article>
        ))}
      </div>

      {selectedDefinition !== undefined && (
        <DetailDialog
          title={selectedDefinition.title}
          description={selectedDefinition.summary}
          eyebrow="智能分析模块"
          onClose={() => { setDetailId(undefined) }}
          actions={<>
            <button type="button" className={css.secondaryButton} onClick={() => { setDetailId(undefined) }}>关闭</button>
            <button
              type="button"
              className={css.primaryButton}
              data-action="analysis-module-chat"
              data-analysis-module-id={selectedDefinition.id}
              onClick={() => { openModule(selectedDefinition) }}
            >用此模块打开 AI 助理</button>
          </>}
        >
          <div className={css.detailTags} data-testid="analysis-module-tags">
            <span>{selectedDefinition.eyebrow}</span>
            {selectedDefinition.experts.map(expert => <span key={expert}>{expert}</span>)}
          </div>
          <section className={css.detailSection} data-testid="expert-team">
            <h3>专家团分工</h3>
            <ul className={css.detailList}>{selectedDefinition.experts.map(expert => <li key={expert}>{expert}</li>)}</ul>
          </section>
          <section className={css.detailSection}>
            <h3>工具与数据来源</h3>
            <ul className={css.detailList}>
              {selectedDefinition.tools.map(tool => <li key={tool}>{tool}</li>)}
              {selectedDefinition.sources.map(source => <li key={source}>数据：{source}</li>)}
            </ul>
            <p className={css.detailFootnote}>模型按需读取资料；输入框只保留自然语言问题，不会出现业务 JSON。</p>
          </section>
          <section className={css.detailSection}>
            <h3>预期产出</h3>
            <ul className={css.detailList}>{selectedDefinition.outputs.map(output => <li key={output}>{output}</li>)}</ul>
          </section>
        </DetailDialog>
      )}
    </div>
  )
}
