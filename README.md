# sayiiwhat

sayiiwhat 是一个本地视频外挂字幕生成工具。它用 `whisper.cpp` 做语音识别，用 `ffmpeg` 处理音视频，用可选的 VAD 做人声检测，再通过 OpenAI-compatible API 对字幕进行翻译和润色，最终输出与视频同目录的 `.srt` 外挂字幕文件。

当前工程重点支持 macOS / Apple Silicon 的开发与打包；Windows 相关路径和运行时适配代码已预留，但当前产物打包说明以 macOS 为准。

## 当前能力

- 选择本地视频文件，生成外挂字幕 `.srt`。
- 使用 `ggml-large-v3-turbo.bin` 等 whisper.cpp 模型进行本地 ASR。
- 支持 VAD 人声检测，可在创建任务时开启、关闭并选择阈值。
- 支持 OpenAI-compatible API 翻译/润色字幕，可配置 Base URL、API Key、MODEL 和提示词。
- 支持字幕编辑，保存后重新生成最终 `.srt`。
- macOS 安装包会随包携带运行所需的 `ffmpeg`、`ffprobe`、`whisper-cli`、whisper 相关动态库和 VAD 模型。

## 技术栈

- 桌面壳：Tauri 2
- 前端：React 19 + Vite + TypeScript
- 后端：Rust
- ASR：whisper.cpp / `whisper-cli`
- 音视频处理：ffmpeg / ffprobe
- VAD：Silero VAD `ggml-silero-v6.2.0.bin`
- 翻译：OpenAI-compatible Chat Completions API

## 目录结构

```text
.
├── apps/desktop/                         # React + Tauri 桌面应用
│   ├── src/                              # 前端源码
│   ├── src-tauri/                        # Rust / Tauri 工程
│   │   ├── resources/bin/macos/          # macOS 随包工具：ffmpeg、ffprobe、whisper-cli、dylib
│   │   ├── resources/models/vad/         # 随包 VAD 模型
│   │   ├── scripts/package-macos.sh      # macOS .app 后处理与 DMG 生成脚本
│   │   └── tauri.conf.json               # Tauri 配置
│   └── package.json
├── models/
│   └── ggml-large-v3-turbo.bin           # 开发/测试用 whisper.cpp ASR 模型
├── vendor/whisper.cpp/                   # whisper.cpp 源码副本，主要用于参考或重新构建 sidecar
├── scripts/fetch-whisper-cpp.sh          # 按固定 revision 恢复 vendor/whisper.cpp
├── package.json                          # workspace 脚本入口
└── pnpm-workspace.yaml
```

## 开发机前置依赖

macOS 开发和打包建议使用 Apple Silicon 机器。

必须安装：

- Xcode Command Line Tools
- Rust stable
- Node.js
- pnpm

建议版本检查：

```bash
xcode-select -p
rustc --version
cargo --version
node --version
pnpm --version
```

`cmake` 和全局 `ffmpeg` 不是运行应用的硬性要求：

- 如果只是运行当前工程、使用随包的 sidecar、打 macOS 包：不需要依赖全局 `ffmpeg`。
- 如果要从源码重新编译 `whisper-cli` 或重建 whisper.cpp 相关库：需要 `cmake`。
- 如果要替换、验证或自行构建 ffmpeg/ffprobe sidecar：需要本机有 `ffmpeg`，或者准备好对应平台的二进制。

## 安装依赖

在项目根目录执行：

```bash
pnpm install
```

根目录脚本会转发到 `apps/desktop`：

```bash
pnpm dev
pnpm build
pnpm tauri:dev
pnpm tauri:build
```

## 本地开发

启动前端开发服务：

```bash
pnpm dev
```

启动 Tauri 开发模式：

```bash
pnpm tauri:dev
```

开发模式下，应用会优先使用用户配置的工具路径；如果没有配置，则尝试解析应用资源目录或系统 `PATH` 中的 `ffmpeg`、`ffprobe`、`whisper-cli`。

ASR 模型默认不写死在应用里。开发测试时可以在 GUI 里选择：

```text
models/ggml-large-v3-turbo.bin
```

## macOS 编译与打包

### 1. 确认生产构建可通过

```bash
pnpm build
```

这一步会执行 TypeScript 检查和 Vite 前端构建。

### 2. 生成 Tauri release app

```bash
pnpm tauri:build
```

Tauri 会生成基础 `.app` 和初始 bundle。当前配置里的 bundle resources 只包含占位说明文件，真正运行所需的 macOS sidecar 和 VAD 模型由下一步脚本复制进去。

项目已在 `apps/desktop/src-tauri/.cargo/config.toml` 中为 macOS target 指定 `/usr/bin/clang` / `/usr/bin/clang++` 作为 Rust linker 和 C/C++ 编译器，避免本机 PATH 中其他名为 `cc` 的脚本或包装器干扰 release 构建。

### 3. 复制运行时资源并生成 DMG

```bash
./apps/desktop/scripts/package-macos.sh
```

这个脚本会做几件事：

- 将 `apps/desktop/src-tauri/resources/bin/macos/` 复制到 `.app/Contents/Resources/resources/bin/macos/`。
- 将 `apps/desktop/src-tauri/resources/models/` 复制到 `.app/Contents/Resources/resources/models/`。
- 给 `ffmpeg`、`ffprobe`、`whisper-cli` 和 `.dylib` 设置可执行权限。
- 使用 macOS 自带的 `hdiutil` 重新生成 DMG。

产物路径：

```text
apps/desktop/src-tauri/target/release/bundle/macos/sayiiwhat.app
apps/desktop/src-tauri/target/release/bundle/macos/sayiiwhat_0.1.0_aarch64.dmg
```

### 一条命令打包 macOS 产物

```bash
pnpm tauri:build && ./apps/desktop/scripts/package-macos.sh
```

## 模型与运行时资源说明

### ASR 模型

当前仓库根目录的模型文件：

```text
models/ggml-large-v3-turbo.bin
```

它用于开发和测试。当前 macOS 打包脚本不会把这个 1GB+ 的 ASR 大模型自动打入 `.app`，原因是体积很大，而且 GUI 已支持用户选择本地模型文件。

如果之后希望发行包内置 ASR 模型，需要单独调整打包策略，例如：

- 将模型复制到 Tauri resource 目录；
- 在 Rust 侧增加默认模型解析逻辑；
- 接受 DMG 体积显著增加。

### VAD 模型

VAD 模型较小，会随包内置：

```text
apps/desktop/src-tauri/resources/models/vad/ggml-silero-v6.2.0.bin
```

用户机器不需要额外下载 VAD 模型。

### ffmpeg / ffprobe / whisper-cli

macOS 产物会随包携带：

```text
apps/desktop/src-tauri/resources/bin/macos/ffmpeg
apps/desktop/src-tauri/resources/bin/macos/ffprobe
apps/desktop/src-tauri/resources/bin/macos/whisper-cli
```

以及 whisper.cpp 运行所需的 `.dylib` 文件。用户机器正常不需要单独安装 `cmake`、`ffmpeg` 或 `whisper.cpp`。

### vendor/whisper.cpp

`vendor/whisper.cpp` 是当前开发时保留的 whisper.cpp 源码副本，主要用于参考源码、确认参数或重新构建 `whisper-cli`。应用日常运行不直接依赖这个目录，真正随包运行的是 `apps/desktop/src-tauri/resources/bin/macos/` 下的二进制和动态库。

为了避免换机器或重新 clone 后 vendor 来源不清，项目提供了固定版本恢复脚本：

```bash
./scripts/fetch-whisper-cpp.sh
```

当前固定 revision：

```text
ggerganov/whisper.cpp@5ed76e9a
```

如果未来将项目放入 git 仓库，建议二选一：

- 保留 `vendor/whisper.cpp` 并明确提交策略；
- 或不提交 vendor，改用该脚本或 git submodule 恢复固定版本。

## 翻译 API 配置

sayiiwhat 使用 OpenAI-compatible API。GUI 中可以配置：

- Base URL
- API Key
- MODEL
- 翻译/润色提示词
- 目标语言

配置示例：

```text
Base URL: https://api.openai.com/v1
MODEL: gpt-4.1-mini
```

也可以使用其他兼容 OpenAI API 格式的服务。不要把真实 API Key 写入 README、提交记录或测试脚本。

## 测试

前端生产构建：

```bash
pnpm build
```

Rust 测试：

```bash
cd apps/desktop/src-tauri
cargo test
```

如果需要真实 API smoke test，使用环境变量传入密钥，不要写进源码：

```bash
cd apps/desktop/src-tauri
SAYIIWHAT_TEST_API_KEY="sk-..." \
SAYIIWHAT_TEST_BASE_URL="https://api.example.com" \
SAYIIWHAT_TEST_MODEL="model-name" \
cargo test real_api_translation_layout_smoke -- --ignored
```

## 常见问题

### 打开 App 后找不到 ffmpeg / whisper-cli

先确认是否执行过：

```bash
./apps/desktop/scripts/package-macos.sh
```

只运行 `pnpm tauri:build` 时，当前工程不会自动把完整 sidecar 复制进 `.app`。

### DMG 生成失败或出现 rw.*.dmg 临时文件

`hdiutil` 失败时可能留下临时 `rw.*.dmg` 文件。确认没有正在挂载或写入后，可以删除这些临时文件再重新执行打包脚本。

### Dock 图标没有立刻更新

macOS 可能缓存旧图标。先退出并重新打开 App；如果仍不更新，可以执行：

```bash
killall Dock
```

### 用户机器是否需要安装 cmake / ffmpeg / whisper

正常安装 sayiiwhat 的用户不需要安装这些开发工具。macOS 包里应携带运行时需要的 `ffmpeg`、`ffprobe`、`whisper-cli`、动态库和 VAD 模型。

但 ASR 大模型当前不随包内置，用户需要在 GUI 中选择本地 whisper.cpp 模型文件。

## 当前平台状态

- macOS / Apple Silicon：当前重点支持，README 中的打包流程以此为准。
- Windows：代码层面保留跨平台路径和 `.exe` sidecar 解析逻辑，但当前仓库还没有完整 Windows 打包产物说明与随包二进制清单。
