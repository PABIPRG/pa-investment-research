/** Programmatic Settings navigation requests shared by desktop commands and the shell. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Latest request to reveal Settings, optionally selecting a section. */
export interface SettingsOpenRequest {
  revision: number
  sectionId: string | undefined
}

/** Settings shell navigation service. */
export class SettingsUiRuntime extends Service {
  /** Observable request stream consumed by the single Settings shell. */
  readonly requests: SnapshotStore<SettingsOpenRequest> = createSnapshotStore({
    revision: 0,
    sectionId: undefined,
  })

  /** @param ctx - owning settings-domain plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'settingsUi')
  }

  /**
   * Request that Settings open, optionally at one registered section.
   * @param sectionId - registered section to select, or undefined for the shell default.
   */
  open(sectionId?: string): void {
    this.requests.update((draft) => {
      draft.revision += 1
      draft.sectionId = sectionId
    })
  }
}
