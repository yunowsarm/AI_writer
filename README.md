# 基于 Web 的 AI 短剧剧本辅助创作系统

## 首次下载后启动

完整前后端源码分别位于 `web/` 和 `server/`，在项目根目录统一安装依赖、启动。详细步骤见 [启动说明](docs/启动说明.md)，包含 Windows 一键启动、已有 MySQL 的配置、构建运行和常见错误。

Windows 安装 Node.js 22 LTS 与 MySQL 8.0 后，在项目根目录执行：

```powershell
npm ci
npm run setup
npm run dev
```

以上 `setup` 适用于 Windows 独立数据库模式，默认需要 `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe`。使用已有数据库的电脑，请按启动说明的第二种方式配置，不执行 `setup`。

打开 **http://127.0.0.1:3003/**。后端使用 **31001** 端口，本机独立 MySQL 使用 **3308**。管理员初始凭据由初始化生成，保存在本机 `.local/首次登录.txt`。日常可直接双击根目录 `启动系统.cmd`。

仓库只提供源码、数据库建表迁移和空白配置示例，不包含原电脑的账号、作品、数据库、API Key 或邮箱授权码。每台新电脑需要初始化自己的数据库；登录后从“API 配置”添加个人模型供应商。

正式工程：**Vue 3 + Element Plus + Tiptap / Node.js + Express / MySQL / DeepSeek**。

本机项目路径：`D:\WORK\金科毕设\殷宇涵`。启动时请使用本目录下的 `启动系统.cmd`。

完整系统使用 `web/` 与 `server/`，前后端通过同源 `/api` 访问 MySQL 与模型服务。

## 直接使用

页面右上角提供 **明亮 / 暗色 / 随系统** 三种主题，默认随系统。选择保存在当前浏览器，刷新后保留；“随系统”会实时响应系统外观变化。登录与密码重置页面也有主题入口。主题只影响显示，不修改账号、剧本或 AI 配置。

本机已完成独立 MySQL 初始化。打开 **http://127.0.0.1:3003/**，或双击 **启动系统.cmd**。

- 管理员：打开 `.local/首次登录.txt` 查看随机生成的初始账号密码；这份文件仅在本机保存，请勿分享。
- 普通用户：在登录页面注册即可，数据真实存入 MySQL。
- AI：每个用户从左侧“API 配置”填写自己的 Key、选择模型、测试连接；保存后仅对本人立即生效，不共用管理员或环境 Key。
- 切勿把 Key 填到前端、发到评论或提交到版本控制；浏览器只接收是否已配置的标识。

API 配置页面地址：`http://127.0.0.1:3003/settings/api`，所有登录用户可用。Key 输入框留空只保留本人的 Key，已保存密钥不回显；连接测试只请求模型列表，测试不等于保存。配置存于 MySQL 的 `user_ai_settings`，密钥使用 AES-256-GCM 加密；主密钥文件 `.local/ai-master.key` 仅保存在后端。清除个人配置后不回退到环境 Key。迁移旧版本时，仅将旧页面配置归还审计确认的原保存者，旧文件随后归档为 `.local/ai-settings.json.legacy`。

当前联调保留了一部标注为“示例作品”的手动剧本，便于直接查看编辑、公开阅读和审核后的效果。它不是模型生成结果。其他运营统计来自实际本机操作。

## 已实现功能

AI 用量入口：**左侧菜单 → AI 用量**，或直接打开 `http://127.0.0.1:3003/usage`。所有登录用户仅能查看本人的近 7 / 30 / 90 天用量，支持模型筛选、调用次数与 Token 趋势、成功率、耗时及分页明细。只汇总模型实际返回的 Token，未采集的历史记录不会补造数据。侧栏创作提示卡片可通过右上角关闭按钮收起。

广场和阅读页的点赞采用空心 / 实心拇指图标，收藏采用空心 / 实心星形，选中后分别用紫色和金色提示。操作期间防重复提交，后端成功后才更新页面；模板收藏也返回当前用户真实状态。点赞图形来源为 [Lucide thumbs-up](https://lucide.dev/icons/thumbs-up)，开源许可证保存在 `web/src/assets/icons/LUCIDE-LICENSE.txt`。

| 模块 | 功能 |
| --- | --- |
| 账号与个人中心 | 注册、密码登录、HttpOnly Cookie 会话、个人资料、修改密码、一次性邮箱找回、微信登录与账号绑定流程、统计、浏览历史清理 |
| AI 创作 | DeepSeek 真实接口适配、参数保存复用、先大纲后分集、SSE 增量输出、停止、失败状态、继续剩余分集、任务记录 |
| 富文本编辑 | 分集管理、场景 / 人物插入、台词编辑、加粗斜体、撤销重做、段落上下移动、格式标准化、自动保存、保存冲突保护 |
| AI 打磨 | 局部 / 整集续写、扩写、精简、风格改写、重创作；候选预览、应用 / 放弃与正文变化校验 |
| 版本管理 | 真实数据库快照、历史预览、恢复新版本、保留回退前备份 |
| 剧本库与公开社区 | 私有草稿、待审核与已公开筛选、题材 / 标签 / 标题搜索、热度排序、点赞收藏、评论、举报、独立分享阅读页 |
| 模板 | 六种官方题材、个人模板创建与维护、预览、套用、收藏；管理员可维护完整参数与上下架 |
| 导出分享 | 整部剧本复制、UTF-8 Markdown / TXT 下载、公开链接；撤回后链接失效 |
| 管理后台 | 用户查询、禁用 / 恢复、真实指标与图表、审核冻结快照、公开内容下架、举报处理、操作日志 |

**第三方配置边界**：DeepSeek Key、微信网站应用 AppID / Secret / 回调域名、SMTP 邮箱均由实际账号提供。未配置时系统明确禁用对应能力，不伪造登录或生成成功。AI 已通过本地可控上游测试，尚未使用你的 Key 做真实计费调用；微信真实扫码和邮件投递还需配置后验收。

## 本机启动与开发命令

建议 Node.js 22 或以上、npm、MySQL 8.0。依赖版本由根目录 `package-lock.json` 锁定。

```powershell
npm ci
npm run setup
npm run dev
```

- `npm run setup`：Windows 本机独立实例初始化，创建 `mujian` 和 `mujian_test`，初始化表和官方模板、首次管理员；重复运行不会清空作品或重置已有管理员密码。
- `npm run dev`：后端 31001、前端 3003，前端 `/api` 代理至 Express。关闭启动窗口停止前后端；数据库独立运行。

本地开发可使用 `http://127.0.0.1:3003` 或 `http://localhost:3003` 登录，也支持后端构建页面的 31001 端口。来源校验仅兼容本机回环地址和明确配置的端口，其他站点仍会被拒绝。前端端口被占用时启动会明确报错，不再自动递增；生产环境仍必须将 `APP_ORIGIN` 配置为实际访问地址。
- `npm run build`：构建前端到 `web/dist`。
- `npm start`：Express 提供 API 与构建后的前端页面，默认 http://127.0.0.1:31001 。使用此方式请把 `.env` 的 `APP_ORIGIN` 改为此实际访问地址，并在生产部署使用 HTTPS 与 `NODE_ENV=production`。
- `npm test`：在独立 `mujian_test` 数据库验证邮箱强制注册、旧账号补验、过期和重放等流程；测试模拟邮件投递，不发送真实验证码。需先准备测试库，不能将此命令作为首次启动步骤。
- `停止项目数据库.cmd`：校验实例标识后关闭本项目数据库，不删除数据。再次启动系统会自动重启实例。

### 独立 MySQL 实例说明

本机使用已安装的 MySQL 程序，监听 `127.0.0.1:3308`；数据实际保存在项目 `.local/mysql-data`，不改动系统已有 MySQL 服务。Windows 的此版本 MySQL 对中文数据路径有限制，因此初始化工具给 `.local/` 建立一个空闲的 SUBST 盘符别名，通常为 `M:`，实际数据仍在 D 盘本项目内。启动时会自动恢复别名，不能把它当成新的磁盘或手动删除其中的数据。

数据库账号与随机密码保存在 `.env`；实例管理凭据在 `.local/mysql-root.json`。`.env`、`.local/` 和依赖 / 构建产物均已加入 `.gitignore`。备份项目作品时必须同时备份数据库，不能只复制代码。

迁移个人 API 配置时必须同时保留数据库与 `.local/ai-master.key`，否则已有密文无法解密；该文件不得上传公开仓库。

如使用自己的 MySQL 或非 Windows 环境：先手动创建专用数据库及受限账号，把连接配置写入 `.env`，运行 `npm run migrate -w server` 建表，再按需设置 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 初始化管理员。不要运行 Windows 本机初始化工具覆盖自定义数据库配置；开发启动器仅在本机 3308 且存在项目数据目录时自动管理独立实例。

## 工程模块

```text
server/
  src/app.js                # Express 组装、安全中间件和路由
  src/config.js             # 环境配置，前端不能导入
  src/db/                   # MySQL 连接、事务、表结构
  src/shared/               # 内容清洗、schema、统一错误
  src/modules/auth/         # 密码、会话、重置、微信
  src/modules/users/        # 个人资料和统计
  src/modules/scripts/      # 剧本、分集、版本、提审、导出
  src/modules/ai/           # 提示词、DeepSeek 流解析与任务
  src/modules/templates/    # 模板与参数配置
  src/modules/community/    # 广场、分享、互动、收藏
  src/modules/admin/        # 管理权限、审核、治理、统计
  src/modules/settings/     # 个人 API 配置、加密与旧配置迁移
  src/modules/usage/        # 个人模型调用和用量统计
  scripts/                  # 数据库迁移与种子
  test/                     # 独立 MySQL / HTTP 集成测试
web/src/
  api/                      # HTTP、SSE、下载客户端
  stores/                   # 登录态
  layouts/                  # 工作区布局
  components/               # 展示组件
  shared/                   # 日期、状态、反馈
  views/                    # 各业务模块页面
  views/editor/             # 富文本、自动保存、AI 助手拆分
  views/admin/              # 用户 / 模板 / 审核 / 指标独立面板
  views/settings/           # 所有登录用户的个人 API 配置
  views/usage/              # 所有登录用户的个人 AI 用量
  styles/                   # 基础样式与正式系统样式
tools/                      # 本机初始化、启动与安全停止
docs/                       # API 契约、架构、验证记录、页面截图
```

文件顶部说明职责；复杂流程处补充局部注释。模块之间通过服务函数与 API 契约协作，不把所有页面和后台逻辑堆在一个文件中。代码统一使用 Prettier 格式化。

主题模块位于 `web/src/shared/theme.js`、`stores/theme.js`、`components/ThemeSwitcher.vue`；`public/theme-init.js` 提前设置首屏主题。配色分为 `styles/theme.css`（语义变量及组件适配）与 `styles/theme-palette.css`（暗色颜色表）。现有浅色数值作为 CSS 变量回退值保留；`node tools/theme-palette.mjs` 可重复生成颜色表，不使用全页面反色滤镜。

## 文档

- [后端接口文档](docs/API.md)
- [系统架构与数据流](docs/ARCHITECTURE.md)
- [验证记录与待外部配置验收项](docs/验收记录.md)
- [初期设计方案](系统设计与实现方案.md)，技术变更以本 README 和正式代码为准。

当前本地版采用单个 Express 进程管理运行中的 AI 取消句柄；任务结果持久化于 MySQL。若后续部署多个后端实例，应引入共享任务队列与分布式配额，不能直接启动多个实例共享这份内存任务表。
