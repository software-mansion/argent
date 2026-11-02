<br/>
<p align="center"><a href="https://argent.swmansion.com"><img width="1100" height="382" alt="argent-header" src="https://github.com/user-attachments/assets/6cec01d5-da3c-4b6c-97c3-0374a63c213c" /></a></p>

<p align="center"><a href="README.md">English</a> | <b>日本語</b> | <a href="README.zh-CN.md">简体中文</a></p>

[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-1?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-1&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-2?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-2&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-3?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-3&n=1)

**[Argent](https://argent.swmansion.com)** は、AI アシスタントが iOS シミュレーター、Android エミュレーターと実機、TV（Apple TV、Android TV、Fire TV）、Electron/Chromium アプリを直接操作できるようにします。ボタンのタップ、画面のプロファイリング、バグの再現まで、CLI から離れずに行えます。

```bash
npx @swmansion/argent@latest init  # pnpm: pnpm dlx @swmansion/argent@latest init
```

<p align="center"><img src="https://github.com/software-mansion/argent/blob/main/assets/showcase.gif" alt="argent showcase video gif" width="100%" /></p>

## できること

- **操作** - タップ、スワイプ、ジェスチャー、文字入力、ハードウェアボタン。TV では D-pad、デスクトップではマウスとキーボードに対応。
- **E2E** - 操作の流れを一度 E2E テストとして記録し、バグの再現やスモークテストとして決定的にリプレイ。
- **ビジュアルリグレッション** - ベースラインとライブキャプチャの差分を比較。OCR とフォントを考慮。
- **プロファイリング** - Hermes、React DevTools、Xcode Instruments、Perfetto で、レンダリング、CPU ホットスポット、ハングを分析。
- **デバッグ** - ログ、ネットワーク（axios を含む `XMLHttpRequest`、Expo 版を含む `fetch`、ネイティブ）、JS の評価、ネイティブおよび React のツリー。
- **React Native** - 追加設定なしでビルド、起動、反復開発。

アシスタントに _「Argent で何ができる？」_ と聞くと、すべてのツールを一覧できます。

## ドキュメント（英語）

[インストール](https://docs.swmansion.com/argent/docs/fundamentals/installation) · [対応プラットフォーム](https://docs.swmansion.com/argent/docs/fundamentals/supported-platforms) · [CLI](https://docs.swmansion.com/argent/docs/reference/cli) · [エディター](https://docs.swmansion.com/argent/docs/reference/editors)

## プライバシー

テレメトリーはオプトアウト方式です。無効にするには `argent telemetry disable` を実行してください。詳しくは[プライバシー通知](https://github.com/software-mansion/argent/blob/main/Telemetry.md)をご覧ください。

## ライセンス

Argent は混合ライセンスモデルを採用しています。**ソースコード**は [Apache License 2.0](LICENSE.txt) の下で公開されています。**プロプライエタリなバイナリ**（プラットフォームごとの `bin/<platform>/simulator-server` および `bin/darwin/ax-service` 実行ファイル、ならびに `native-devtools-ios` 内の `.dylib` ファイル）は Software Mansion S.A. の知的財産であり、本プロジェクト内での使用に限りライセンスされます。明示的な書面による許可なく、これらを逆コンパイル、リバースエンジニアリング、または再配布することは禁止されています。Argent を使用することにより、この構成を承認し、同意したものとみなされます。詳細は [LICENSE](https://github.com/software-mansion/argent/blob/main/LICENSE.txt) をご覧ください。

この翻訳と英語版の README または LICENSE の内容に相違がある場合は、英語版が優先されます。

## Argent は Software Mansion が開発しています

[Software Mansion](https://swmansion.com) は 2012 年から Web アプリとモバイルアプリの開発に携わってきたソフトウェア開発会社です。私たちは React Native のコアコントリビューターであり、React Native に関するあらゆる問題に精通しています。次の理想のプロダクトづくりをお手伝いします – [お問い合わせ](https://swmansion.com/contact/projects?utm_source=argent&utm_medium=readme)。

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=argent-github "Software Mansion")](https://swmansion.com)
