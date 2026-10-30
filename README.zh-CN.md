<br/>
<p align="center"><a href="https://argent.swmansion.com"><img width="1100" height="382" alt="argent-header" src="https://github.com/user-attachments/assets/6cec01d5-da3c-4b6c-97c3-0374a63c213c" /></a></p>

<p align="center"><a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <b>简体中文</b></p>

[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-1?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-1&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-2?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-2&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-3?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-3&n=1)

**[Argent](https://argent.swmansion.com)** 让你的 AI 助手直接操控 iOS 模拟器、Android 模拟器和真机、电视（Apple TV、Android TV、Fire TV）以及 Electron/Chromium 应用。点击按钮、分析页面性能、复现 Bug，全程无需离开命令行。

```bash
npx @swmansion/argent@latest init  # pnpm: pnpm dlx @swmansion/argent@latest init
```

<p align="center"><img src="https://github.com/software-mansion/argent/blob/main/assets/showcase.gif" alt="argent showcase video gif" width="100%" /></p>

## Argent 能做什么？


- **交互操作（Interact）** - 点按、滑动、手势操作、文字输入、硬件按键；电视上支持方向键（D-pad），桌面端支持鼠标和键盘。
- **端到端测试(E2E)** -将操作路径录制一次并保存为端到端测试，之后可确定性重放，用于复现问题或执行冒烟测试。
- **视觉回归（Visual Regression)** - 将基准截图与实时截图进行对比，支持 OCR 并感知字体差异。
- **性能分析(Profiling)** - Hermes、React DevTools、Xcode Instruments、Perfetto：分析渲染、CPU 热点和卡顿。
- **调试(Debugging)** - 日志、网络请求（`XMLHttpRequest`，含 axios；`fetch`，含 Expo 的实现；以及原生请求）、JS 执行、原生和 React 组件树。
- **React Native** - 构建、启动、迭代，无需额外配置。

问问你的 AI 助手 _“Argent 能做什么？”_，即可列出全部工具。

## 文档（英文）

[安装](https://docs.swmansion.com/argent/docs/fundamentals/installation) · [支持的平台](https://docs.swmansion.com/argent/docs/fundamentals/supported-platforms) · [CLI](https://docs.swmansion.com/argent/docs/reference/cli) · [编辑器](https://docs.swmansion.com/argent/docs/reference/editors)

## 隐私

遥测默认开启，可通过 `argent telemetry disable` 关闭。详见[隐私声明](https://github.com/software-mansion/argent/blob/main/Telemetry.md)。

## 许可证

Argent 采用混合许可模式。**源代码**基于 [Apache License 2.0](LICENSE.txt) 发布。**专有二进制文件**（各平台的 `bin/<platform>/simulator-server` 和 `bin/darwin/ax-service` 可执行文件，以及 `native-devtools-ios` 中的 `.dylib` 文件）是 Software Mansion S.A. 的知识产权，仅授权在本项目内使用。未经明确书面许可，禁止对其进行反编译、逆向工程或再分发。使用 Argent 即表示你知悉并同意上述许可结构。完整内容请参阅 [LICENSE](https://github.com/software-mansion/argent/blob/main/LICENSE.txt)。


## Argent 由 Software Mansion 打造

[Software Mansion](https://swmansion.com) 成立于 2012 年，是一家在 Web 和移动应用开发方面经验丰富的软件公司。我们是 React Native 核心贡献者，擅长解决各类 React Native 问题。我们可以帮你打造下一款理想产品 – [联系我们](https://swmansion.com/contact/projects?utm_source=argent&utm_medium=readme)。

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=argent-github "Software Mansion")](https://swmansion.com)

