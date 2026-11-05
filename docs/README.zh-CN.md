# AQUA 澜 · 宿主嵌入式本地视频库播放器

> **AQUA 澜** —— 界面是苹果式毛玻璃，内核是自己编译的 mpv。
> 架构上采用 IINA / LosslessCut 同款的**宿主嵌入**范式：Electron 负责窗口与 UI，
> `libmpv` 只负责把画面渲染进宿主给的原生窗口，因此能用上系统级 Acrylic 磨砂、
> 原生目录选择器、虚拟列表与弹性滚动，而不去碰 mpv 那套 OSD/libass。

本仓库同时包含 mpv 源码与部署说明，可自由修改 `src\` 下的代码后一键重编。

**项目根目录（即本文件夹）**：`C:\Users\Administrator\Documents\小龙虾\视频播放器`
下文中出现的 `src\`、`bin\`、`build.bat` 等均为相对此目录的路径。

## 〇、安装与打包（给使用者）

| 想要什么 | 怎么做 |
|---|---|
| **安装到电脑** | 双击 `app\dist\AQUA-1.0.0-Setup.exe` → 可选安装路径 → 桌面/开始菜单会出现带图标的「AQUA 澜」快捷方式 |
| **免安装直接用** | `app\dist\win-unpacked\AQUA 澜.exe` 双击即可（整个文件夹一起拷走也能用） |
| **自己重新打包** | 双击根目录的 **`打包.bat`**（生成图标 → 装依赖 → 出安装包，约 3~5 分钟） |
| **开发态运行** | 双击 **`启动播放器.bat`**（不打包，改代码即时生效） |

* 图标由 `app\tools\make-icon.ps1` 用 GDI+ 现场绘制（圆角方块 + 海水渐变 + 播放三角），
  一次生成 16/24/32/48/64/128/256 七档 `build\icon.ico`，并注入 exe 与安装包。
* 安装包**未做代码签名**（没有证书），Windows SmartScreen 可能拦一下，
  点「更多信息 → 仍要运行」即可；卸载走「设置 → 应用」或控制面板。

## 一、当前环境

## 一、当前环境

| 项目 | 内容 |
|---|---|
| 源码目录 | `src\`（完整 git 仓库） |
| 源码版本 | git `master` 分支，HEAD `baa3e11d42`（v0.41.0 之后 589 个提交） |
| 构建环境 | `C:\msys64` 的 **CLANG64** 环境 |
| 编译器 | clang 23.1.3 |
| 构建工具 | meson 1.12.1 / ninja 1.13.2 |
| 主要依赖 | FFmpeg 9.0.2、libplacebo 7.360.1、libass 0.17.5、LuaJIT、shaderc、spirv-cross、uchardet、libdvdnav |
| 编译产物 | `src\build\mpv.exe`、`libmpv-2.dll` |
| 便携运行版 | `bin\`（含 135 个条目 / 167MB，可整体拷到别的机器直接跑） |

> 中文路径已验证可用：meson 配置 54 秒、全量编译 2 分 17 秒、产物可独立运行（详见第八节）。

已启用特性：d3d11、opengl、vulkan、libmpv、lua、curl、jpeg、lcms2、libarchive、cdda、dvdnav、uchardet、shaderc。
未启用：vapoursynth、javascript、subrandr（需 Rust，非必需）。

## 二、目录结构

```
C:\Users\Administrator\Documents\小龙虾\视频播放器\
├── src\                 # mpv 源码（git 仓库）
│   └── build\           # 构建输出（mpv.exe / mpv.com / libmpv-2.dll）
├── bin\                 # 便携运行目录（exe + 全部运行时 DLL）
│   └── portable_config\ # 便携配置（优先于 %APPDATA%\mpv）
│       ├── scripts\explorer.lua          # 右侧文件栏脚本（mpv.exe 独立运行时用）
│       └── script-opts\explorer.conf     # 文件栏配置
├── app\                 # ★ 宿主外壳：Electron + libmpv + 苹果风格侧边栏
│   ├── src\main\        # 主进程：mpv 绑定 / 原生窗口 / 状态机
│   ├── src\renderer\    # 界面：标题栏外壳 / 磨砂侧边栏 / 控制条
│   ├── tools\           # probe-native.js 原生层自检 / make-icon.ps1 图标生成
│   ├── dist\            # ★ 打包产物：安装包 + 免安装版
│   └── build\           # 图标资源（由 make-icon.ps1 生成）
├── build\               # ★ 应用图标 icon.ico / icon.png
├── 打包.bat              # ★ 一键出安装包
├── build.bat            # 一键增量重编译 + 自动同步到 bin\
├── deploy.bat           # 只做同步（不编译）
├── deploy.sh            # 同步脚本（供 MSYS2 调用）
├── run-mpv.bat          # 启动自己编译的 mpv（无外壳，纯 mpv）
├── 启动播放器.bat        # ★ 启动宿主外壳版播放器
└── README.md            # 本文件
```

## 三、改完代码怎么重编

1. 用 VS Code 打开本文件夹（`src` 是子目录，直接打开根目录更顺手）
2. 改代码
3. 双击 `build.bat`

- 增量编译通常几秒到几十秒；全量约 2~5 分钟
- 想彻底重来（改了编译选项/升级了依赖）：`build.bat clean`
- 首次运行会自动 `meson setup`（当 `src\build` 不存在时）
- 编译失败时看 `src\build\meson-logs\meson-log.txt`

命令行的等价写法（在 MSYS2 CLANG64 终端里，先进到本文件夹）：

```bash
cd "/c/Users/Administrator/Documents/小龙虾/视频播放器/src"
meson compile -C build            # 编译
meson configure build             # 查看/修改构建选项
```

## 四、想改什么，去哪找

| 需求 | 位置 |
|---|---|
| 命令行选项的定义与解析 | `options/options.c`、`options/m_option.c`（改选项还要更新 `DOCS/man/options.rst`） |
| 播放主循环 / 加载文件 | `player/playloop.c`、`player/loadfile.c` |
| 对外命令（IPC/脚本用） | `player/command.c` |
| 视频输出与画质 | `video/out/vo_gpu_next.c`、`video/out/vo_d3d11.c`、`video/out/gpu/` |
| 硬件解码 | `video/out/hwdec/`、`video/hwdec.c` |
| 视频滤镜 | `video/filter/` |
| 音频输出 | `audio/out/ao_*.c` |
| 解封装 / 容器 | `demux/demux.c`、`demux/demux_lavf.c` |
| 字幕渲染 | `sub/` |
| 快捷键与输入 | `input/`、`etc/input.conf` |
| 内置 OSC 界面 | `player/lua/osc.lua`（Lua 脚本，改完**不用重编译**，直接替换即可） |
| libmpv 对外 API | `include/mpv/client.h`、`libmpv/client.c` |
| 配置文件加载 | `options/parse_configfile.c`、`options/m_config_core.c` |

## 五、版本切换 / 更新源码

```bash
cd "/c/Users/Administrator/Documents/小龙虾/视频播放器/src"
git checkout v0.41.0        # 切到稳定版
git checkout master         # 回开发版
git pull                    # 拉取最新代码（之后建议 build.bat clean）
git log --oneline -10       # 看最近提交
```

## 六、已加入的功能：右侧文件栏（explorer.lua）

在播放窗口右侧绘制一个可交互的文件浏览器面板，可直接选文件夹、点文件播放。

- 源码位置：`src\player\lua\explorer.lua`（随 git 版本管理）
- 部署位置：`bin\portable_config\scripts\explorer.lua`（mpv 自动加载，已随 `build.bat` 同步）
- 配置：`bin\portable_config\script-opts\explorer.conf`

**顶部按钮（鼠标点击）**：

| 按钮 | 作用 |
|---|---|
| `选择文件夹…` | 弹出 Windows 原生文件夹选择对话框，可浏览「此电脑」下的任意位置，含 **C 盘 / D 盘** |
| `↑ 上级` | 返回上一级目录 |
| `C:` `D:` … | 一键直达对应磁盘根目录（自动探测本机可用盘符，从 C 开始枚举） |

面板内的按键：

| 操作 | 按键 |
|---|---|
| 开关面板 | `Shift+E`（任何时候可用） |
| 上下移动 / 翻页 | `↑` `↓` / `PgUp` `PgDn` / 滚轮 |
| 播放文件、进入目录 | `Enter` 或鼠标左键 |
| 返回上级目录 | `Backspace` 或鼠标右键 |
| **选择文件夹** | `o`（弹出 Windows 原生文件夹选择对话框） |
| 关闭面板 | `Esc` |

可调选项（`explorer.conf`）：`dir` 初始目录、`width` 宽度、`font_size` 字号、
`auto_open` 启动即展开、`bg_alpha` 背景透明度、`show_hidden` 显示隐藏文件。

实现要点：面板用 `mp.create_osd_overlay("ass-events")` + `mp.assdraw` 绘制，
鼠标坐标读 `mouse-pos` 属性做命中测试，目录遍历用 `mp.utils.readdir`，
文件夹对话框通过 `mp.utils.subprocess` 调 PowerShell `FolderBrowserDialog`（UTF-8 输出编码已处理）。

## 七、★ AQUA 澜（宿主外壳版播放器，苹果风格磨砂侧边栏）

`app\` 下是一套**宿主嵌入架构**的播放器：窗口、侧边栏、控制条全部由 Electron（网页）绘制，
mpv 内核只负责把画面渲染进宿主给它的原生子窗口。这正是 IINA / LosslessCut 的标准做法，
避免了在 mpv 的 OSD/libass 里硬画 UI 的所有痛点。

### 启动

* **已安装**：开始菜单 / 桌面双击「AQUA 澜」（带图标）；
* **开发态**：双击 **`启动播放器.bat`**（首次运行自动 `npm install`，Electron 走国内镜像）。

诊断模式：`set AQUA_DEBUG=1` 后启动，主进程会输出布局与渲染层日志。

### 架构分层（为什么这样设计）

| 层 | 位置 | 职责 |
|---|---|---|
| 原生层 | `app\src\main\win32.js` | ① 创建「视频承载窗口」（mpv 的 `--wid` 需要挂在一个 HWND 下）；② 给浮层窗口开系统级 Acrylic 磨砂 |
| 绑定层 | `app\src\main\mpv.js` | koffi 直连 `bin\libmpv-2.dll`：`mpv_create / set_option_string("wid",...) / command / wait_event`，另带一个无画面实例后台扫时长 |
| 状态机 | `app\src\main\main.js` | 单一状态源驱动全部窗口；侧边栏开合动画结束后才同步一次 mpv 视口尺寸 |
| 界面层 | `app\src\renderer\` | 外壳标题栏（交通灯）/ 磨砂侧边栏 / 底部控制条 / 输入玻璃层 |

关键点：

* **为什么侧边栏是独立窗口而不是网页里的 div**——mpv 的画面是原生子窗口，永远盖在网页内容之上；
  任何想浮在视频之上的 UI 都必须是独立窗口。好处是能直接调系统 Acrylic，
  **真正模糊它背后的视频画面**（CSS `backdrop-filter` 对原生窗口无效）。
* **为什么有一个透明「输入玻璃层」**——视频是原生子窗口，网页收不到它上面的鼠标；
  这层透明窗口负责「鼠标一动唤醒界面」「右侧边缘悬停唤出侧边栏」「单击暂停 / 双击全屏 / 滚轮音量 / 拖放播放」。
* **视频承载窗口必须是「顶层受管窗口」**——Electron 的渲染窗口
  `Chrome_RenderWidgetHostHWND` 在 Z 序里会压住所有兄弟窗口，把 mpv 画面整块盖掉
  （表现为「在播但全黑」）。正确做法是给 mpv 一个 **owned 顶层窗口**
  （`SetWindowLongPtr(GWLP_HWNDPARENT)` 挂到外壳窗口下）：Windows 保证它始终在外壳之上、
  随外壳最小化，鼠标事件由上层 glass 接管。层叠顺序为 `glass（输入层）→ mpv 画面 → 外壳`。
* **动画期间不重绘视频**——侧边栏 280ms（`cubic-bezier(0.16,1,0.3,1)`）开合的整个过程中
  不重设 mpv 视口，动画结束才同步一次，零掉帧。
* **虚拟列表 + 弹簧滚动**——侧边栏只渲染可视区十几行，上万文件也不卡；
  滚动用刚度/阻尼积分器，天然带惯性滚动与边界回弹。

### 操作

| 操作 | 方式 |
|---|---|
| 开关侧边栏 | `Ctrl+B` 或 `Ctrl+\`，顶栏的侧栏按钮（**默认就是展开的**） |
| 边缘悬停唤出 | 鼠标移到窗口最右侧边缘停留 300ms，移开自动收回；手动开合后 1.8 秒内不再自动唤出，避免"关了又被顶回来"的闪烁 |
| 边缘悬停唤出 | 鼠标移到窗口最右侧边缘停留 300ms，移开自动收回 |
| 固定 / 取消固定 | 侧边栏右上角图钉；「浮层 / 推挤」按钮切换布局模式 |
| 选择文件夹 | 侧边栏顶部按钮（系统原生目录选择器），或 `Ctrl+O` |
| 过滤 / 搜索 | 侧边栏搜索框；列表支持滚轮惯性、拖动滚动条、`↑↓ / PgUp / PgDn / Home / End` |
| 拖拽改变宽度 | 抓住侧边栏左缘（240~560px） |
| 播放 / 暂停 | 空格、单击视频画面 |
| 快退 / 快进 10 秒 | 胶囊两侧按钮（`gobackward.10` / `goforward.10`） |
| 长按穿梭 | 按住快进/快退不放：0.35s→2x、1s→5x、1.8s→12x 阶梯加速；松手恢复原速 |
| 进度条 | 底部全宽细线，靠近变粗；拖动时按帧定位并暂停底层声音，松手恢复；悬停弹出**缩略图预览** |
| 时间码 | 点击胶囊里的时间码，在「已播/总长」与「剩余倒计时」之间切换 |
| 音量 | 悬停静音键平滑展开滑块；`↑↓`、滚轮 |
| 倍速 | 底栏右侧「1.0x」→ 弹出 0.5/0.75/1.0/1.25/1.5/2.0 菜单；`[` `]` 微调，`\` 复位 |
| 画中画 | `Ctrl+P` 或顶栏的画中画按钮：主窗口切成无边框置顶小窗，按视频宽高比锁定 |
| 全屏 | `F`、双击画面、顶栏按钮；全屏静止 2.5s 进入沉浸模式（光标隐藏，鼠标移动唤醒） |
| 上一/下一 | `Ctrl+← / Ctrl+→`；播放结束自动连播下一项 |
| 右键列表项 | 在资源管理器中显示 |

### 侧边栏：目录多路管理 + 播放上下文

**目录不再只有「选一个文件夹」这一种入口**：

| 能力 | 交互 |
|---|---|
| 分割按钮 | 主区打开系统选择器；右侧箭头弹出「最近访问 5 条 / 固定目录 / 清除历史」 |
| 面包屑 | 当前目录拆成可点击层级，点哪级跳哪级 |
| 拖拽 | 从资源管理器直接拖文件夹进侧边栏，立刻切换并扫描 |
| 排序 | 文件名（自然排序）/ 修改时间 / 时长 / 观看进度 |
| 视图 | 隐藏视频扩展名、紧凑视图（行高 68→48） |
| 播放模式 | 顺序连播 / 单曲循环 / 乱序播放 |

**卡片上的播放上下文**：

* 正在播放的条目：标题变强调色，徽标位置换成跳动的**律动条**；
* 卡片底部 2px **观看进度条**，副信息里显示「已看 18:40」；
* 看完的条目右侧打浅灰 `✓`；
* 同名 `.srt/.ass/.vtt` 点亮 **CC** 徽标、同名 `.m4a/.aac` 点亮 **♪** 徽标，
  播放时自动 `sub-add` / `audio-add` 绑到 mpv 管线；
* 断开的源文件整条变灰加删除线，播放前先探活，不会把内核搞崩。

**系统联动与键盘盲操**：

* 右键条目 → 系统原生菜单：资源管理器中显示 / 复制路径 / 复制文件名 / 绑定外挂字幕 /
  从列表隐藏 / 重命名 / 移到回收站；
* 双击文件名原地重命名（同步改磁盘文件）；
* `↑` `↓` 移动焦点、`Enter` 起播、`Space` 播放/暂停、敲 `03` 触发 **type-ahead**、
  `Esc` 先清搜索再退出侧边栏；
* 观看进度每 5 秒落盘，重开自动续播。

### 侧边栏交互的四个坑（事件层级 / 竞态 / 生命周期）

侧边栏是**独立原生窗口**（不是网页里的 div），它和视频视口分属两个 HWND，
所以"展开/收起/点击穿透"这类问题必须按窗口层级来治，而不是靠 CSS。

| 症状 | 根因 | 处理 |
|---|---|---|
| 启动后侧边栏没展开 | 配置里存着上次关闭的状态 | ① 默认值改成展开；② 窗口**首次激活**时若用户还没手动动过侧边栏，强制展开一次（`sidebarUserToggled` 标记） |
| 点按钮"闪一下又回去了" | 双重触发：click 与快捷键/边缘唤出同时生效 | 显隐统一走 `setSidebarVisible(目标状态)`：**不是取反**，而是明确意图；进去先把淡出定时器、边缘唤出定时器全部清掉；再加 200ms 防抖 |
| 展开后被幽灵监听器关掉 | 边缘唤出的自动收起定时器在 450ms 后回魂 | 显隐入口统一打断所有"隐藏"意图；动画期间忽略 `sidebar:hover`（窗口在滑动，进出事件是假的） |
| 鼠标操作视频/侧边栏混淆 | 半透明浮层没有视觉边界 + 拖拽把手会漏事件给视频 | ① 磨砂不透明度提到 85% + 左侧 1px 分界线与投影；② 侧边栏根容器在**冒泡阶段**拦截指针/滚轮事件；③ 拖拽调宽时 `SetCapture` 锁定鼠标并让玻璃层临时忽略鼠标，划到画面上也不会误触暂停 |

侧边栏的 DOM 节点**始终常驻**，显隐只靠动画改变宽度/不透明度，
动画结束后才 `hide()` 窗口 —— 绝不在动画中途销毁，避免白闪。

### 播控条结构与职责边界（对标 QuickTime / Apple TV）

```
╭─ 顶栏：全局与上下文 ─────────────────────────────╮
│ ● ● ●     示例视频.mp4        外观 侧栏 画中画 全屏 │
╰──────────────────────────────────────────────────╯
                  [ 视 频 ]
        ╭──────────────────────────╮
        │ 🔊▁  0:12/1:23   ⏪ ⏸ ⏩   1.0x │   ← 底栏：只管内容本身
        ╰──────────────────────────╯
  ──────────────────────────────────────      ← 全宽渐进式进度条（3px→8px）
```

**同一功能只存在一个控制点**（避免两套组件维护同一状态导致同步 BUG）：

| 区域 | 职责 | 控件 |
|---|---|---|
| 顶栏 | 全局与上下文 | 交通灯、当前文件名、外观、侧边栏折叠、画中画、全屏 |
| 底栏 | 流媒体内容本身 | 进度条穿梭、播放/暂停、快退/快进 10s、音量、倍速 |

底栏内部再分三段（`1fr auto 1fr` 三栏，播控组永远居中）：
左侧音量（悬停展开胶囊滑块）+ 时间码（点击切换剩余倒计时）｜正中快退 10s / 播放暂停 / 快进 10s
（播放键 40px 明显大于两翼 28px）｜右侧倍速。

材质：半透明 `rgba(20,20,20,0.55)` + `blur(28px) saturate(190%)` + 0.5px 白色高光描边。
（系统 Acrylic 是整面矩形效果，会把胶囊的圆角糊成矩形，所以胶囊走自绘材质，
侧边栏/菜单这类矩形面板才用系统磨砂。）

### 点击不卡：三处关键改造

高码率播放时点按钮卡顿，根因与解法：

1. **指令一律 fire-and-forget**。
   同步的 `mpv_command` 要等内核把命令执行完才返回，播放时内核正忙着解码渲染，
   主线程会被拖住几十毫秒。现在全部走 `mpv_command_async`：
   主进程先**乐观更新** state 并立刻广播（界面马上响应），命令再异步丢给 mpv。
   自检脚本里有断言：投递耗时 0ms。
2. **高频更新隔离成微组件**。
   `time-pos` 每帧都变，若每变一次就整条工具栏重绘，就会和点击交互抢渲染算力。
   现在进度条 + 时间码是独立的 `Progress` 微组件，只写自己那几个节点；
   音量 / 倍速是低频组件，值没变就完全不碰 DOM；按钮图标只在离散状态变化时重建。
   主进程侧同时把逐帧广播限流到 20fps、音量拖拽广播限流到 50ms。
3. **磨砂材质隔离到独立图层**。
   `backdrop-filter: blur(28px)` 很吃 GPU，按钮的 hover/active 若波及外层容器，
   容器就要逐帧重算背景模糊。现在材质放在 `.pill::before` 独立图层，
   按键按下态也从 `transform: scale()` 改成纯局部 `background` 变化。

### 倍速与音调校正

* 底栏右侧「1.0x」文本胶囊：固定宽度 50px + 等宽数字（`tabular-nums`），
  档位在 `0.5x~2.0x` 之间切换时按钮宽度不抖。
* 点击向上弹出磨砂轻量菜单，档位 `[0.5, 0.75, 1.0, 1.25, 1.5, 2.0]`，当前档位带小勾选。
* 内核侧对应属性是 `speed`（浮点），切换即 `set speed 1.25`。
* **避免「花栗鼠音」**：显式开启 `audio-pitch-correction=yes`（mpv 基于 scaletempo2），
  1.5x/2x 加速时人声音调保持稳定不尖锐。

### 内核数据流：事件驱动，不用轮询

`mpv_observe_property` 订阅 `time-pos / duration / pause / volume / mute / speed`，
mpv 一变就推 `MPV_EVENT_PROPERTY_CHANGE`，主进程据此刷新状态再广播给各窗口。

* **属性名怎么拿到**：事件结构里只有 `const char *name`，而 koffi 解引用 `char*` 会崩进程。
  解决办法是给每个被观察的属性编一个 userdata 编号，mpv 会原样回传
  （`mpv_event.reply_userdata`，安全类型），收到事件后按编号反查属性名 —— 一次字符串都不用读。
* **下发指令**：`cycle pause`、`seek ±10 relative`、`seek <t> absolute+exact`（拖拽用 exact 保证帧精确）。

### 三个 libmpv 实例

| 实例 | 用途 | 选项要点 |
|---|---|---|
| 播放器 | 主画面 | `wid`=宿主承载窗口、`osc=no`、输入绑定全关 |
| 时长探测器 | 后台逐个读 duration | `vo=null ao=null` |
| 缩略图 | 进度条悬停预览 | `vo=gpu` + 自己的小承载窗口，`absolute+exact` 跳到鼠标所在时间 |

诊断自检：`cd app && npm run probe`（校验 libmpv 绑定、属性观察链路、Acrylic 材质、第三实例是否可用）。

## 八、配置与运行

- 配置目录：`bin\portable_config\`（已启用，优先于 `%APPDATA%\mpv\`）
- 便携版运行：`bin\mpv.exe`，或双击 `run-mpv.bat`，或把视频拖到 `run-mpv.bat` 上
- 想放进 PATH 当全局播放器：把本文件夹下的 `bin` 加进系统环境变量 `Path`

起步配置（存为 `%APPDATA%\mpv\mpv.conf`）：

```ini
hwdec=auto-safe
vo=gpu-next
profile=gpu-hq
volume=70
save-position-on-quit=yes
sub-auto=fuzzy
screenshot-format=png
```

## 九、环境层面的说明（重要）

1. **pacman 签名校验已关闭**（`C:\msys64\etc\pacman.conf` 里 `SigLevel = Never`）。
   原因：MSYS2 在非交互 shell 下 GPG 校验会卡死，导致首次升级 15 分钟零进度。
   包仍然从 HTTPS 镜像（南京大学 `mirror.nju.edu.cn`，官方源兜底）下载。
   如需恢复校验：把该行改回 `SigLevel = Required`，并执行 `pacman-key --init && pacman-key --populate msys2`。
2. **镜像已改成国内源**：`C:\msys64\etc\pacman.d\mirrorlist.mingw` 与 `mirrorlist.msys` 首行为南京大学镜像。
3. **源码仓库已关闭 CRLF 转换**（`core.autocrlf=false`）。Windows 下 `ci\*.sh`、Lua 脚本必须保持 LF，否则会报语法错误。
4. **升级依赖后**（`pacman -Syu`）建议 `build.bat clean` 重新配置，避免 ABI 不匹配。
5. `src\` 是完整 git 仓库（含 33 万提交历史），可以随时 `git diff` 看自己改了什么，也方便做补丁。
6. **中文路径已验证可构建**：源码现在位于 `C:\Users\Administrator\Documents\小龙虾\视频播放器\`，
   meson 配置 54s、全量编译 2m17s、`mpv.exe` 在干净 PATH 下独立运行均通过。
   `build.bat` / `deploy.bat` / `deploy.sh` 全部用 `%~dp0` 与脚本自身位置推导路径，**不写死任何绝对路径**，
   因此整个文件夹可以随时再搬（含换盘符）。搬迁后首次 `build.bat` 会自动重新 `meson setup`；
   若想更保险，先删掉 `src\build` 再跑 `build.bat clean`。
7. `.bat` 文件已加 `chcp 65001`，双击运行时中文路径不会显示成乱码。
