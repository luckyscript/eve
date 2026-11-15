# Eve Android：通过中继连接电脑

Eve Android 是 Kotlin / Jetpack Compose 原生客户端。电脑主动连接中继，手机通过中继访问电脑固定工作区内的 Eve，不需要给电脑开放入站端口。

## 已实现范围

- 粘贴、深链接或相机扫码导入一次性配对邀请；Android Keystore 加密保存凭据，禁止 Android 云备份。
- 已配对电脑、连接状态、前台重连、本地解绑。
- 手机新建会话、发送任务、接收工具事件、显示模型状态与独立验收状态、取消和只读同步。
- 保存任务 requestId；断线/重启后查询原任务，不自动换 ID 重发。
- 查看当前配对建立的会话、Skills、Capabilities、Context；电脑允许时可压缩上下文。
- Eve 的 Logo、夏娃头像、浅深主题和中文原生界面。

本版电脑端使用 CLI 启用和配对，**尚未接入 macOS 图形客户端的远程设置页**。手机只可访问本配对创建的会话，不会自动暴露所有电脑历史。v1 不包含附件、FCM、可靠后台常连、任意工作区选择、远程修改模型密钥或进化管理。电脑应用/connector 必须在线；电脑睡眠时不能执行任务。

## 技术与安全

传输参考并实测兼容 [Alma Relay](https://github.com/yetone/alma-relay) 的协议 1，验证基线为 `30d56513aefc4d96b624d878af758aaa5468d9f8`（MIT）。上游仅作为透明中继，Eve 没有复用或声称兼容 Alma 私有配对、业务 API 和 E2E 协议，也不使用 Alma 的官方中继或推送身份。

Eve 自己的协议见 [Remote v1](remote-protocol-v1.md)：带外 32-byte 随机配对凭据、双向 HMAC 身份证明、HKDF-SHA256 分方向派生密钥、AES-256-GCM、逐连接严格序号和新 nonce。首次成功认证绑定手机 clientId；邀请码默认十分钟内使用，已绑定手机可在邀请过期后重连。电脑撤销会断开相应通道。

这是基于预共享密钥的协议，**不提供前向保密，也未经过独立密码学审计**。中继仍能观察路由和连接元数据；生产必须使用 HTTPS/WSS。HTTP/WS 仅限显式开发模式的 loopback 地址。手机不保存电脑模型 API key。

电脑 `.eve/remote/` 保存私有设置、配对和幂等账本；已排除 Git，目录 0700、文件 0600。requestId 与操作参数哈希、配对绑定，重复请求不重复执行，冲突拒绝。崩溃后未决请求标记 unknown，不自动重放。远程工具仍受原工作区保护；默认禁止远程写入和压缩，需要在电脑本地显式允许。回滚、取消或断线不能撤销已发生的文件写入。

## 构建 APK

需要 JDK 17+（本次使用 Android Studio JBR 21）、Android SDK platform 34 和兼容 Build Tools。项目自带 Gradle 8.13 Wrapper，下载包由官方 SHA-256 校验。

```bash
# 在仓库根目录，按自己的 SDK / JDK 路径设置
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
npm run android:build
npm run android:test
```

`local.properties`、Gradle 缓存、编译中间文件、日志和 `dist/` 均被忽略。构建脚本将 APK 复制为 `dist/Eve-android-debug.apk`。可用 Android Studio 打开 `android/`，也可直接安装生成的 debug APK。它不是签署上架的 release 包。

如机器已有可信 Gradle 分发，可以设置 `EVE_GRADLE_BIN=/absolute/path/to/gradle`，脚本将使用该启动脚本而不重新下载 Wrapper 分发。测试与应用使用 API 26+；当前目标/编译 API 34，尚未验证所有厂商设备。

## 准备中继节点

生产请自行部署 Alma Relay，按其官方 Docker/Caddy 或 Workers 文档配置 TLS 与注册权限。不要把电脑的 loopback 测试地址当作外网服务。仓库没有替用户部署公网节点。

本地兼容性测试可运行：

```bash
node remote/dev-relay.mjs
```

该脚本将固定版本的上游下载到忽略的验证目录，仅在 `127.0.0.1:8787` 启动，首次需要网络安装上游 `ws` 依赖；只适用于开发，不代替生产 TLS 部署。

## 电脑端启用

在希望手机操作的工作区运行。工作区应已有可用的 Eve 模型配置。

```bash
eve remote enable --relay-url https://relay.example --name "我的 Eve"
eve remote start
```

`start` 以前台进程运行，关闭终端会断开中继。另开一个终端、在**同一工作区**执行：

```bash
eve remote pair
```

它只在这一显式操作中输出配对链接。将链接私下传到手机，在“添加电脑”中粘贴；也可用自己信任的本地二维码工具将链接转为二维码后扫码。**不要将配对链接贴到公开日志、截图或 Git。** 本版电脑 CLI 不自动绘制二维码，手机相机扫描支持 Eve 配对格式。

若中继需要 registration key 或要允许文件写入，先创建私有 `.eve/remote-settings.local.json`，例如：

```json
{
  "enabled": true,
  "relayUrl": "https://relay.example",
  "desktopName": "我的 Eve",
  "development": false,
  "allowWrite": true,
  "allowCompact": false,
  "contracts": {}
}
```

再执行 `eve remote configure --file .eve/remote-settings.local.json`。可按上游要求额外填写 `registrationKey`，该值仅留电脑本地，不要提交。`allowWrite` 为 true 时，手机授权任务可以修改工作区文件；没有 OS 沙箱，务必选定可信、允许修改的工作区。

```bash
eve remote status
eve remote revoke PAIR_ID
eve remote disable
```

`disable` 关闭远程访问并请求收尾；`revoke` 撤销指定配对，运行中的 connector 在轮询后断开它。手机“解绑”只删除手机本地凭据，不能替代电脑撤销。

## 本地模拟器验证

仅在已安装 API 36.1 Google Play ARM64 镜像的 Mac 上，可使用仓库的独立验证 AVD：

```bash
bash android/scripts/emulator.sh
adb -s emulator-5580 install -r dist/Eve-android-debug.apk
adb -s emulator-5580 reverse tcp:8787 tcp:8787
```

对应电脑配置可用 `http://127.0.0.1:8787`，但必须显式开启 `development:true` / `--dev-loopback`。仅 debug APK 放开 loopback 明文传输，非 loopback 不允许明文。

本地真实模型 UI 夹具：`node remote/android-fixture.mjs`，生成受保护的 `.eve/runs/android-fixture.json`，只供自动化私下导入，不打印凭据。最多 6 次模型请求，任务在隔离工作区运行。结束进程会删除该工作区复制的模型配置；fixture 不是生产服务。

## 验证命令与证据口径

```bash
npm test
npm run check
npm run verify:tui
npm run verify:remote       # 真实上游 relay；模型响应可控，不产生模型费用
npm run verify:remote-live  # 真实上游 relay + 真模型，最多 12 次请求
npm run android:test
npm run android:build
```

已实际通过的证据包括：Gradle assembleDebug、Android JVM 协议测试、独立模拟器安装、真实 Relay 上的 Android 配对、从手机原生发送按钮触发任务并在电脑独立读回产物。另一个真实模型脚本验证了契约验收与两轮持久续聊（5 次请求）。手机 UI 任务未选择契约，明确显示 `not_requested`，不能冒称该 UI 任务做了宿主契约验收。

相机扫码的代码入口已编译，但本轮配对用深链接/确认按钮完成，**未实测实体相机扫码**。本轮使用模拟器通过 ADB reverse 连接真实本地中继，不是公网/蜂窝网络可靠性测试。APK 内有窗口截图保护，自动化通过 UI 层级和电脑账本检查，没有为展示解除凭据保护。

完整原始模型与配对状态只保存在忽略的本地证据中。公开记录只包含判定、版本、请求次数和哈希，不包含邀请码、路由 token、模型密钥或隐藏输入。
