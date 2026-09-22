# SheetJS 官方发行包

`xlsx-0.20.3.tgz` 是从 [SheetJS 官方 CDN](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz) 下载的原始发行包，版本为 `0.20.3`，许可证为 Apache-2.0；许可证正文保留在包内。归档没有解包、修改或重新打包。

SHA512（Base64）：`oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`。

使用 [SheetJS 官方推荐的本地归档方式](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring)，使生产 `pnpm deploy --prod --legacy` 能解析此依赖，同时保持 `blockExoticSubdeps: true`。本包的 `files` 清单包含该归档，复制或打包此包时相对依赖路径仍有对应文件；pnpm 锁文件记录相同的完整性摘要。

升级时只从官方来源取得指定版本，核对归档身份、许可证与 SHA512，更新本说明、依赖声明及锁文件，并运行持仓导入测试和 CLI/Electron 两条真实生产 deploy。不得通过关闭间接依赖来源限制来绕过验证。
