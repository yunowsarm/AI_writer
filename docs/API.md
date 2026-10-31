# 后端 API 契约 v1

基础地址 `/api`。请求 / 响应默认 UTF-8 JSON；AI 为 SSE，导出为文本流。接口实现位于 `server/src/modules`，这里记录实际实现，不把规划中的接口当成已存在能力。

## 约定

- Cookie：`mujian_session`，HttpOnly、SameSite=Lax、7 天有效；生产模式 Secure。前端同源请求，无需在 JavaScript 读取 token。
- 写操作检查 Origin 与 APP_ORIGIN；账号禁用后现有会话失效。
- 管理员接口除登录外还需 `role=admin`；私有对象无权读取时统一返回 404。
- 失败体：`{ "code": "REVISION_CONFLICT", "message": "...", "requestId": "..." }`。字段错误另有 `details: [{field,message}]`。
- 400 参数或状态不合法；401 未登录 / 登录失败；403 权限或账号禁用；404 不存在或不可见；409 重复 / 版本冲突；413 请求体过大；429 限流；502 模型错误；503 外部服务未配置。
- 请求体上限 1MB；通用请求每分钟 240 次；认证接口 15 分钟 40 次；评论与举报每分钟 12 次；单用户 AI 每小时 30 次且同一时刻一个任务。
- 分页：`page>=1`，`size=1..60`（默认 12），返回 `{items,total,page?}`。全部列表不是同一结构：参数配置 / 历史 / 版本 / 任务、后台模板与日志返回受限数组，见各项。
- ID 为正整数；题材为 `逆袭 / 复仇 / 甜宠 / 家庭 / 悬疑 / 都市`。

## 账号与个人中心

| 方法与路径                        | 请求 / 查询                 | 返回                                                               |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| GET /health                       | 无                          | `{ok,database:'mysql',aiMode:'per-user'}`；同时检查数据库连接      |
| GET /auth/capabilities            | 无                          | `{wechat,passwordReset,aiConfigured,model}`，不返回任何凭据        |
| POST /auth/register               | `{email,password,nickname}` | 201 用户信息并设置会话；密码 8..128 字符，昵称 1..40，邮箱最长 190 |
| POST /auth/login                  | `{email,password}`          | 用户信息并设置会话                                                 |
| POST /auth/logout                 | 无                          | `{ok:true}`，清除当前会话                                          |
| POST /auth/password/change        | `{oldPassword,newPassword}` | `{ok:true}`；需要登录，所有其他会话失效                            |
| POST /auth/password-reset/request | `{email}`                   | 统一提示；SMTP 未配返回 503，不泄漏邮箱是否存在                    |
| POST /auth/password-reset/confirm | `{token,password}`          | 一次性 token 为 64 字符，15 分钟有效；成功后旧会话全部失效         |
| GET /auth/wechat                  | 可选 `bind=1`               | 重定向微信网站扫码授权；绑定需已登录                               |
| GET /auth/wechat/callback         | `code,state`                | 校验一次性 state、服务端换取微信身份、建立会话并重定向工作台       |
| GET /me                           | 登录                        | `{id,email,nickname,bio,role,createdAt}`                           |
| PATCH /me                         | `{nickname,bio}`            | 更新后的用户信息；简介最长 500                                     |
| GET /me/stats                     | 登录                        | `{scripts,words,favorites,history,days}`                           |
| GET /me/history                   | 登录                        | 最近 50 条仍可公开读取的浏览记录数组                               |
| DELETE /me/history                | 登录                        | 清空当前用户历史                                                   |
| POST /events/visit                | 无                          | 记录实际工作区进入事件，返回 `{ok:true}`                           |

## 剧本与分集

剧本输入：

```json
{
  "title": "重生后，我成了自己的靠山",
  "genre": "逆袭",
  "tags": ["女性成长"],
  "synopsis": "一个设计师重新找回选择权的故事。",
  "outline": "起：失去署名；承：寻找证据；转：公开真相；合：新的开始。",
  "config": {}
}
```

标题 1..120；最多 10 个标签、单个 30 字符；简介最长 5000；大纲最长 100000。

| 方法与路径                            | 参数                                                       | 返回 / 行为                                          |
| ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| GET /scripts                          | 分页、q、genre、status=all/private/pending/public/rejected | 个人作品列表，含 config/tags、分集数和字数           |
| POST /scripts                         | 上述输入                                                   | 201 `{id}`；默认私有                                 |
| GET /scripts/:id                      | 作者                                                       | 完整工作稿，含 episodes 与最近 5 条审核记录          |
| PATCH /scripts/:id                    | 上述完整输入                                               | 更新资料；不会改变已经公开的快照                     |
| DELETE /scripts/:id                   | 作者                                                       | 软删除并撤回公开和待审申请                           |
| POST /scripts/:id/episodes            | `{title}`                                                  | 201 `{id}`；顺序追加，最多 80 集                     |
| PATCH /episodes/:id                   | 下述保存体                                                 | 新分集对象，revision 加 1；同事务保存快照            |
| GET /episodes/:id/versions            | 作者                                                       | 最近 100 版本摘要数组                                |
| GET /episodes/:id/versions/:versionId | 作者                                                       | 历史版本完整正文                                     |
| POST /episodes/:id/restore            | `{versionId,revision}`                                     | 新 revision 正文；保留回退前备份                     |
| POST /scripts/:id/publish             | 作者                                                       | `{reviewId}`，冻结当前整部作品快照；重复待审返回 409 |
| POST /scripts/:id/unpublish           | 作者                                                       | 立即撤回公开并取消待审，返回 `{ok:true}`             |
| GET /scripts/:id/export               | `type=txt/md`，作者                                        | `text/plain; charset=utf-8` 附件，包含所有分集       |

正文保存体：

```json
{
  "title": "第 1 集 · 这一次，换我选择",
  "revision": 3,
  "document": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "林知夏：这次由我选择。" }] }] },
  "html": "<p>林知夏：这次由我选择。</p>",
  "text": "林知夏：这次由我选择。",
  "reason": "手动保存"
}
```

document 可为 null（由 AI 生成 HTML 时）；HTML 最大 500000、文本最大 200000 字符。revision 必须等于当前服务器值。冲突返回 409 `REVISION_CONFLICT`，客户端保留当前草稿，提示先备份再重新载入。HTML 经白名单清洗后保存，不能使用脚本或事件属性。

## DeepSeek 与生成任务

参数结构 `params`：

```json
{
  "theme": "一个被低估的设计师逆风翻盘",
  "people": "林知夏，27岁，设计师；陆景深，32岁，投资人",
  "background": "当代都市的设计公司",
  "style": "逆袭",
  "styleNote": "赛博朋克悬疑，冷峻快节奏",
  "episodes": 3,
  "duration": 2,
  "twist": "每集结尾留悬念，反转符合人物动机。"
}
```

theme 2..1000；people/background/twist 最长 3000；style 为预设题材，styleNote 可选、最长 1000，用于补充自定义叙事风格；episodes 1..80；duration 1..10 分钟。

| 方法与路径                     | 请求                                                      | 返回                                                      |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| GET /generation-configs        | 登录                                                      | 最近 100 份个人参数数组                                   |
| POST /generation-configs       | `{name,params}`                                           | 201 `{id}`；名称 1..80                                    |
| DELETE /generation-configs/:id | 所有者                                                    | `{ok:true}`                                               |
| POST /ai/generate              | `{title,params,scriptId?}`                                | SSE 流；scriptId 为继续剩余分集，使用作品已保存的原始参数 |
| POST /ai/rewrite               | `{episodeId,revision,operation,text,style?,instruction?}` | SSE 候选流，不自动修改正文                                |
| GET /ai/jobs                   | 登录                                                      | 最近 30 次个人任务摘要数组                                |
| GET /ai/jobs/:id               | 任务所有者                                                | 完整状态、已接收 output、script_id、model、error_code     |
| POST /ai/jobs/:id/cancel       | 任务所有者                                                | 中止仍在运行的任务；已结束返回 404 `JOB_NOT_RUNNING`      |

operation：`continue / expand / shorten / style / regenerate`。text 1..50000 字符；style 最长 100；instruction 最长 1000。revision 过期时不发起模型调用。

SSE 采用 POST fetch 读取。每个事件包含 `id` 顺序号、`event` 与 JSON `data`：

| event     | data                              | 含义                                       |
| --------- | --------------------------------- | ------------------------------------------ |
| start     | `{jobId,scriptId?}`               | 任务已创建                                 |
| script    | `{scriptId}`                      | 生成关联的作品                             |
| phase     | `{phase,message,episode?,total?}` | 大纲或分集阶段                             |
| delta     | `{text,phase?,episode?}`          | 最终文本增量                               |
| episode   | `{episode,total,scriptId}`        | 一集完整正文已保存                         |
| done      | `{scriptId}` 或 `{text,revision}` | 全部生成或改写候选完成                     |
| cancelled | `{message,scriptId?}`             | 已停止，完成的分集仍保留                   |
| error     | `{code,message,scriptId?}`        | 流开始后的失败，前端显示错误与保留内容入口 |

缺少 Key 在流开始前返回 HTTP 503；上游 Key 无效为 `AI_AUTH_FAILED`，限额为 `AI_RATE_LIMIT`，截断为 `AI_OUTPUT_TRUNCATED`，连接失败为 `AI_CONNECTION_FAILED`。服务启动时上次遗留 running 任务转为 failed / `SERVER_RESTARTED`，可继续已保存作品。

实现参考：[DeepSeek 首次调用](https://api-docs.deepseek.com/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。base URL 和模型名可由环境配置，不写死在前端。

## 模板、社区与收藏

模板输入 `{title,genre,description,params,outline}`；description 最长 5000，outline 最长 100000。

| 方法与路径                        | 参数与约束                                                  | 返回                                                                     |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET /templates                    | 分页、q、genre、sort=recent/hot、kind=all/official/personal | 当前可用官方模板与自己的个人模板                                         |
| GET /templates/:id                | 可见性校验                                                  | 完整模板，含本人收藏状态 favorited                                       |
| POST /templates                   | 模板输入，登录                                              | 201 `{id}`，仅可创建 personal                                            |
| PATCH /templates/:id              | 模板输入，个人所有者                                        | `{ok:true}`                                                              |
| DELETE /templates/:id             | 个人所有者                                                  | 标记 offline                                                             |
| POST /templates/:id/apply         | 可见且 active                                               | `{params,outline}`，使用次数递增                                         |
| GET /public/scripts               | 分页、q、genre、sort=recent/hot                             | 审核通过的公开作品摘要，不含私有 config                                  |
| GET /public/scripts/:id           | 可匿名访问                                                  | 审核快照、分集、作者、最近 100 评论、点赞数与当前用户互动状态            |
| PUT /public/scripts/:id/like      | 登录且作品公开                                              | 幂等点赞                                                                 |
| DELETE /public/scripts/:id/like   | 登录                                                        | 幂等撤销                                                                 |
| POST /public/scripts/:id/comments | `{body}`，1..1000 字符                                      | 201 `{id}`                                                               |
| DELETE /public/comments/:id       | 评论作者或管理员                                            | 隐藏评论                                                                 |
| POST /public/scripts/:id/report   | `{reason}`，2..500 字符                                     | 201 `{ok:true}`                                                          |
| GET /favorites                    | 分页、登录                                                  | `{items,total}`，item.type=script/template；失效内容仅显示通用不可用提示 |
| PUT /favorites/:type/:id          | type=script/template                                        | 校验可见性后幂等收藏                                                     |
| DELETE /favorites/:type/:id       | 登录                                                        | 幂等取消收藏                                                             |

广场热度为 `点赞*3 + 有效状态评论*2 + 阅读事件*0.1`，同分按更新时间；该版本使用累计热度，不声称是时间窗推荐算法。打开详情页写入阅读事件，已登录时更新去重浏览历史。

## 个人 AI 配置与用量

### AI 用量视图

`GET /me/usage?days=7&model=&page=1&size=20`，所有登录用户可读，所有数据仅限本人；客户端传入的 userId 不改变归属。

- days：7 / 30 / 90，以 UTC 日期计算，含当天；model 为空代表全部模型。
- summary：任务数、实际模型调用数、各状态调用数、输入 / 输出 / 总 Token、平均耗时、成功率、缺失用量的调用数及没有请求明细的历史任务数。
- daily：按请求发起日期汇总调用数和已记录 Token；models：模型分布；items / total：分页调用明细。
- 同一多集任务的大纲和每集正文分别记录为一次调用；Key 测试读取模型列表不计入生成用量。
- Token 与缓存命中／未命中明细来源于 DeepSeek 流中的 usage，写入 `ai_requests`；缺失时为 NULL，不按字符数或缓存比例估算。中断、失败、历史任务可能没有完整 Token，页面明确提示覆盖范围。
- 费用按 DeepSeek 官方价格表展示美元峰／谷费用区间；只有输入缓存命中、未命中及输出 Token 都由上游返回时才计算，未知模型或历史缺少缓存明细的调用不估算。价格来源：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)。
- 不返回提示词、生成正文或任何密钥；只代表当前系统的调用，不代表整个 DeepSeek 账户的账单。

采集协议参考 [DeepSeek 流式用量字段](https://api-docs.deepseek.com/api/create-chat-completion/)。现有数据库运行 `npm run migrate -w server` 即可新增请求表，不清空历史任务或作品。

### 页面 API 配置

全部需要登录，用户身份只来自会话。配置接口不返回密钥，审计日志不记录密钥；配置保存到 MySQL `user_ai_settings`，Key 使用 AES-256-GCM 加密，主密钥保存在后端 `.local/ai-master.key`。生成和改写只使用当前用户的 Key，不使用环境公共 Key。

| 接口                      | 请求 / 返回                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET /me/settings/ai       | 返回 `{model,timeout,baseUrl,keyConfigured,source}`；禁止缓存                                                                             |
| PUT /me/settings/ai       | `{model,timeout,apiKey?}`；timeout 为 10000..600000 毫秒，apiKey 留空只保留本人当前值；首次保存必须填 Key；本人有运行中 AI 任务时返回 409 |
| POST /me/settings/ai/test | 同上输入；使用当前或新填写 Key 请求 GET /models，返回 `{ok,models,modelAvailable,message}`，不生成文本、不自动保存；按用户每分钟最多 6 次 |
| DELETE /me/settings/ai    | 清除本人配置和 Key，不回退到环境 Key；历史用量保留                                                                                        |

连接测试依据 [DeepSeek 模型列表接口](https://api-docs.deepseek.com/api/list-models/)。模型可自行输入；服务地址沿用服务器配置，不允许从浏览器把密钥发送到任意第三方地址。

## 管理后台

下列接口全部需要管理员角色；除已注明列表外，写操作默认返回 `{ok:true}`。

| 方法与路径                       | 请求 / 查询                                          | 返回                                                                |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| GET /admin/metrics               | 无                                                   | `{users,visits,scripts,generations,completed,pending,trend,genres}` |
| GET /admin/users                 | 分页、q                                              | `{items,total}`，不含 password_hash                                 |
| PATCH /admin/users/:id           | `{status:'active'/'disabled'}`                       | 当前管理员和其他管理员受保护；禁用普通账号立即撤销所有会话          |
| GET /admin/templates             | 无                                                   | 官方模板完整数组，包括 offline                                      |
| POST /admin/templates            | 模板输入                                             | 201 `{id}`                                                          |
| PATCH /admin/templates/:id       | 模板输入 + status=active/offline                     | 编辑与上下架                                                        |
| GET /admin/reviews               | 分页、status=pending/approved/rejected/cancelled/all | `{items,total}`，含 snapshot 冻结正文                               |
| POST /admin/reviews/:id/decision | `{approve:boolean,reason?:string}`                   | 驳回时 reason 至少 2 字；通过原子替换 published_json                |
| GET /admin/content               | 分页                                                 | `{items,total}` 公开内容列表                                        |
| POST /admin/content/:id/takedown | `{reason}`，2..500                                   | 清空公开快照、取消待审、关联举报标记 resolved、记录日志             |
| GET /admin/reports               | 无                                                   | 最近 100 条待处理举报                                               |
| PATCH /admin/reports/:id         | 无                                                   | 标记 resolved                                                       |
| GET /admin/audit                 | 无                                                   | 最近 100 条管理员操作日志                                           |

数据看板统计真实持久化事件，UTC 日期分组；不使用原型的示意数字。评论、举报和内容审核的治理决定由管理员作出，本版本未接入自动内容审查第三方服务。
