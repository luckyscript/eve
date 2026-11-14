# Eve · 夏娃

Eve 的命名取自夏娃。品牌围绕新生、好奇、知识与自我进化：深青绿色的有机小写 e 生出两片叶，表达知识萌芽与持续成长；人物头像以栗棕卷发、榛绿眼睛和叶饰延续同一主题。

这是 Eve 自己的视觉身份，不是 Alma 的人物、自拍或人设。两张原始图像为本次品牌设计中已生成并确认的 AI 图像；不声称人工摄影，也未作商标清查或独占权保证。本次接入只对已确认的原图进行本地派生，不调用外部图像服务。

| 文件 | 用途 |
| --- | --- |
| `eve-avatar-source.png` | 用户指定的原始头像，逐字节保留，暖白背景 |
| `eve-logo-source.png` | 用户指定的原始 e 叶 Logo，逐字节保留；白底展示，PNG 含透明通道 |
| `eve-icon-1024.png` | 1024×1024 图标母版，暖白圆角方形、透明外边距、e 叶核心 |
| `../../macos/Sources/Eve/Resources/eve-logo.png` | 透明前景，保留原形、色彩及抗锯齿，用于自适应品牌底块 |
| `../../macos/Sources/Eve/Resources/eve-avatar.png` | 512×512 头像，仅等比缩小，保留背景及脸部，不重绘、不去背 |
| `../../macos/Sources/Eve/Resources/Eve.icns` | 16/32/128/256/512 pt 各含 1×、2× 的 macOS 图标 |

在仓库根目录运行 `swift scripts/generate-brand.swift` 可复现全部衍生资源。脚本仅使用 macOS AppKit、CoreGraphics、ImageIO 与系统 `iconutil`，从本目录的原图读取，不依赖原始 scratch 路径或第三方包。临时 iconset 自动删除；原始资源不会被脚本覆写。

原生界面通过 `EveBrandMark` 与 `EveAvatar` 统一呈现。Logo 采用浅色暖白、深色浅鼠尾草绿的底块；头像在浅深主题使用同一图像，仅在界面做圆形裁切。侧栏使用 Logo 与 Eve 文字，欢迎页使用 88 pt 头像，助手消息标题使用 24 pt 头像，工具时间线维持原有工具符号。

SwiftPM `.process("Resources")` 支持开发运行。`scripts/build-macos.sh` 将 SwiftPM bundle 和顶层 ICNS 复制进 `.app`，设置 `CFBundleIconFile`，应用从包内优先加载，因此移动 `.app` 不依赖源码目录。原始大图不装入发行包。所有原图、衍生资源与生成脚本均可版本化；`.build/`、`dist/` 和本地验证截图保持忽略追踪。
