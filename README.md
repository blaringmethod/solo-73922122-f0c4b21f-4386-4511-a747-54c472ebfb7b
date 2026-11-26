# 双语字幕控台 · Bilingual Subtitle Console

用 Node.js（**零运行时依赖**，仅内置模块）实现的双控台双语字幕系统：开演前录入一份有序中英台词，A / B 两个控台实时共用；当班控台负责「切下一句 / 上一句 / 选句重播」；支持任期围栏式接班、指令幂等重发、投影断线重连与迟到消息防回退。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
# 若 3000 端口被占用：
HOST_PORT=8080 docker compose up --build
```

打开：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| 🧪 **接班演示页** | <http://localhost:3000/demo> | A 台 + B 台 + 投影同屏，可一键自动播放验收剧本 |
| 🎛️ 控台 A | <http://localhost:3000/console/A> | 1 号字幕员 |
| 🎚️ 控台 B | <http://localhost:3000/console/B> | 2 号字幕员 |
| 📽️ 投影页 | <http://localhost:3000/projection> | 大屏字幕（双击全屏，右下角有弱网/迟到消息工具） |
| 📝 台词本 | <http://localhost:3000/script> | 开演前录入有序双语台词 |

台词与幂等处理结果持久化在命名卷 `subtitle-data` 的 `/app/data/state.json`，容器重启不丢；想恢复干净演示数据可点演示页「重置」或 `POST /api/reset`。

### 方式二：直接用 Node（≥ 20）

```bash
node server.js          # 不需要 npm install
# PORT=8080 DATA_FILE=./data/state.json node server.js
```

## 在浏览器演示「接班」

**最省事：** 打开 `/demo`，点右上角「▶ 自动播放接班剧本」。页面会用真实 API + 真实 SSE 中继逐步演出并断言：

1. 重置为 A 当班；
2. A 正常切句；
3. 一条「切下一句」模拟回执丢失，同指令号重发 → `Idempotent-Replay: true`，句子只前进一次；
4. B 接班 → `epoch+1`，当前句子原样保留；
5. A 一条未生效的在途旧指令落地 → `409` 永久作废；
6. A 再次接班（`epoch` 继续增大）后重发同一指令 → 仍是首次保存的 `409` 作废结果；另发一条从未到过服务端的旧任期指令，被 `STALE_EPOCH` 围栏拦截；
7. 向投影注入 `revision` 极旧的刺眼「迟到消息」→ 被版本守卫丢弃，画面不变；
8. 模拟投影重连 → 直接恢复当前字幕；A 用新任期继续切句，演出接得上。

**手动叙事（更有舞台感）：**

1. 分别打开控台 A、控台 B、投影页；
2. 在 A 台点几次「切下一句」，看投影跟随；
3. 勾选「让下一条指令模拟回执丢失」再点切句，观察同号自动重发与「没有多切一句」；
4. 在 A 台点「⏱ 准备 3 秒后发送的下一句」，**立刻到 B 台点「申请接班」**；
5. 3 秒后旧指令到达服务端，A 台显示「已作废」，投影不动；
6. A 台重新「申请接班」，再点「🔁 重发上一条指令」——返回的仍是同一份作废结果；
7. 投影页右下角点「🧪 模拟收到迟到旧消息」，画面不回跳，左下角累计拦截数 +1；点「🔌 模拟断连重连」可看到重连后直接同步当前句。

## 需求与机制对照

| 要求 | 实现 |
| --- | --- |
| 一份有序台词，两控台共用 | `PUT /api/script` 集中存储；状态经 SSE `state` 事件广播，所有页面同源共享 |
| 当班控台切下一句 / 选句重播 | `POST /api/command`，`action: next / prev / goto(replay)`；同句重播也会递增 `cueNonce` 重放动画 |
| 接班保留当前字幕 | `POST /api/takeover` 只改 `activeConsole` 与 `epoch`，**绝不改 `currentIndex`** |
| 交班控台未生效指令作废，即使它后来再接班 | 单调递增的任期围栏 `epoch`：旧任期指令 → `409 STALE_EPOCH`；非当班控台指令 → `409 NOT_ON_DUTY`。A→B→A 后当前 `epoch` 更大，旧指令依旧被拦（ABA 安全） |
| 回执丢失，同指令重发返回原结果、不多切 | 每条逻辑指令带 `commandId`（请求体或 `Idempotency-Key` 头）。服务端 `outcomes` 保存**首次处理结果（含 409 作废结果）**，重发原样回放并带 `Idempotent-Replay: true`；效果至多一次。记录持久化、重启后仍可回放 |
| 投影重连直接显示当前字幕 | 新 SSE 连接立即收到权威 `snapshot`；浏览器 `EventSource` 自动重连，`open` 后再显式 `GET /api/state` |
| 迟到消息不能让画面跳回旧状态 | 全局单调 `revision`；投影所有状态入口都过 `rev-guard`，`revision < 已应用版本` 直接丢弃、不碰 DOM。重置也让 `revision` 继续递增，避免长连接投影把重置快照误判为旧消息 |

### 状态里的三个版本号

- `revision`：任何状态变化 +1，用于投影防迟到/乱序；
- `epoch`：接班任期，每次**换控台**接班 +1，用于指令围栏；
- `cueNonce`：实际上屏句变化（切句/重播）+1，仅用于重播入场动画，接班不闪烁。

## HTTP API 速览

```bash
curl localhost:3000/api/health
curl localhost:3000/api/state            # 全量当前状态 + 台词本
curl localhost:3000/api/audit            # 最近审计事件
curl -N localhost:3000/api/events         # SSE：snapshot / state / audit

# 录入台词（也接受 text 或 [{zh,en}]）
curl -X PUT localhost:3000/api/script \
  -H 'Content-Type: application/json' \
  -d '{"lines":[{"zh":"你好","en":"Hello"},{"zh":"再见","en":"Goodbye"}]}'

# 接班
curl -X POST localhost:3000/api/takeover -H 'Content-Type: application/json' -d '{"console":"B"}'

# 指令：commandId 幂等，epoch 为接班时拿到的任期号
curl -X POST localhost:3000/api/command -H 'Content-Type: application/json' -d '{
  "commandId":"'"$(uuidgen)"'", "console":"A", "epoch":1, "action":"next"
}'
# 选句重播：{"action":"goto","index":3}
# 也可用请求头：-H 'Idempotency-Key: my-command-id'

curl -X POST localhost:3000/api/reset    # 恢复内置示例并清空幂等记录
```

错误码：`400 INVALID_SCRIPT / INVALID_ACTION / INVALID_INDEX / INVALID_EPOCH / INVALID_CONSOLE`；`409 NOT_ON_DUTY`（非当班）、`409 STALE_EPOCH`（旧任期，永久作废）。

## 目录结构

```
server.js            # 零依赖 HTTP 服务：静态页 + JSON API + SSE
src/store.js         # 状态机：revision/epoch、幂等 outcomes、围栏、JSON 持久化
public/
  index.html         # 首页导航
  console.html/.js   # A/B 控台（路径 /console/A|/console/B）
  projection.html/.js# 投影页 + 版本守卫接入
  rev-guard.js       # 可在 Node 中单测的单调版本守卫（ESM）
  script.html/.js    # 台词本录入
  demo.html/.js      # 三 iframe 同屏 + 事件中继 + 浏览器自动验收剧本
  common.js          # fetch 封装 / SSE 或 postMessage 中继 / 工具
  styles.css
scripts/
  verify.mjs         # 零依赖端到端自检（API + SSE + 守卫单测 + 重启持久化）
  ui-smoke.mjs       # 可选 jsdom 点击级测试，并真实执行 /demo 剧本
Dockerfile
docker-compose.yml
```

## 测试与核对

```bash
npm run verify                           # 44 项：静态页、幂等、围栏、ABA、SSE、守卫、重启持久化
npm install && npm run verify:ui         # 40 项 jsdom：真实打包前端并点击，含完整 /demo 自动剧本
```

已在开发环境用 Node v22 实际跑通上述全部断言（84 项），并用真实 `curl` 走过同一叙事；`docker-compose.yml` 已通过 YAML 解析校验。

### 尚未在本环境验证 / 已知限制（如实说明）

- 这个沙箱里**没有 Docker CLI/守护进程**，因此我无法在此真正执行 `docker compose up --build`；Dockerfile 仅用 `node:22-alpine` 拷贝零依赖源码并以 `node` 用户运行，健康检查用镜像自带的 busybox `wget`，配置已按规范编写，但镜像构建/Compose 启动需在有 Docker 的环境确认一次。
- 沙箱禁用了 `kill` 系统调用（`EACCES`），测试脚本因此改用 `ALLOW_SHUTDOWN=1` 的本机 HTTP 自检端点让被测进程自行退出；该端点默认关闭，Docker/生产环境不受影响。
- 没有可用的真实浏览器/Chromium，浏览器行为通过 `jsdom` + `esbuild` 打包真实前端代码做点击级验证（含执行 `/demo` 自动剧本），但像素布局、全屏与动画观感未在真实浏览器中目检。
- 单实例内存状态 + JSON 文件持久化，适合剧场单机/内网；没有做多实例共享存储与鉴权（内网控台场景），如需公网暴露请加访问控制与 HTTPS。
