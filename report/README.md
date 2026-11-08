# 分布式数据库课程设计报告

报告初稿沿用桌面 LaTeX Starter 的 A4、中文章标题和页眉样式。正文分为引言、系统设计、系统实现、系统运行与结果分析、总结与展望五章。附录列出启动方式和正文引用的运行记录。往届样式记录见 [TEMPLATE_NOTES.md](TEMPLATE_NOTES.md)。

## 运行环境

- 使用 XeLaTeX，命令行环境需安装含 XeLaTeX、latexmk、CTeX 的 TeX 发行版。
- 中文沿用 V1 的宋、黑、楷字族。优先使用 Windows 的宋体、黑体、楷体，其次尝试 Noto CJK 和文鼎楷体。相应字体缺失时沿用 CTeX 默认字体。西文优先使用 Times New Roman 和 Courier New。

## 编译

在仓库根目录执行：

```bash
cd report
latexmk main.tex
```

成品位于 `report/build/main.pdf`。也可在 Codex LaTeX 编辑器中打开本目录的 `main.tex` 使用内置预览。在 `report/` 目录执行以下命令清理命令行构建产物：

```bash
latexmk -C main.tex
```

## 职责分离

- `config.tex` 保存封面字段与前置页开关。默认与 V1 一致，依次显示诚信承诺、中文摘要和英文摘要。
- `styles/school.sty` 管理页边距、字体、标题字号、页眉、图表和代码格式。
- `frontmatter/` 保存封面、诚信承诺和中英文摘要。
- `chapters/` 按五章存放正文。
- `figures/` 存放报告使用的流程图和实验截图。

## 写作资料

- 系统设计与实现以[系统设计](../docs/system-design.md)和对应版本的源码为起点。代码节选标注源码路径与提交号。
- 运行结果按[归档索引](../evidence/README.md)追溯。图表和日志注明来源 Run ID。
- 图表编号用 `\label` 和 `\ref` 引用。课程版式确定后集中调整样式和前置页。
