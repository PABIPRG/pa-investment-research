/** 独立网站的部署身份；这些工作区不属于 npm 发布集合。 */

/**
 * 识别已登记的独立部署应用，并拒绝身份漂移或误开启 npm 发布。
 * @param directory - 使用正斜线的工作区相对目录。
 * @param manifest - 磁盘读取的应用清单。
 * @returns 是否为合法的独立部署应用；其他工作区仍遵守原发布规则。
 */
export function isDeploymentOnlyApp(
  directory: string,
  manifest: Readonly<{ name?: unknown; private?: unknown }>,
): boolean {
  const expectedDirectory = 'apps/public-observatory'
  const expectedName = '@deepseek-ai/dsh-public-observatory'
  if (directory !== expectedDirectory && manifest.name !== expectedName) return false
  if (directory !== expectedDirectory || manifest.name !== expectedName || manifest.private !== true) {
    throw new Error(`${directory}: deployment-only app must be ${expectedName} in ${expectedDirectory} with private: true`)
  }
  return true
}
