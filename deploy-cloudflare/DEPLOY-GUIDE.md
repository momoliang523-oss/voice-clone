# Cloudflare Worker 部署指南(日语 TTS,面向日本用户)

全程在浏览器里点,不需要装任何软件。总花费:一个域名(约 ¥60~100/年),其余全部免费额度,**不需要信用卡**。

## 第 0 步:买域名

在任意域名商买一个域名,推荐便宜后缀(.top / .xyz / .site 约 ¥10~60/年,.com 约 $10/年)。
可以在 Cloudflare 自家买(注册 Cloudflare 账号后,登录面板左侧「域名注册」→「注册域名」),最省事。

## 第 1 步:注册 Cloudflare 并接入域名

1. 打开 https://dash.cloudflare.com/sign-up 注册(邮箱即可)
2. 左侧点「**添加域**」,输入你买的域名,选 **Free 计划**
3. Cloudflare 会给你**两个 DNS 服务器地址**(形如 xxx.ns.cloudflare.com)
4. 去你买域名的网站,把域名的 DNS 服务器改成这两个地址
5. 回到 Cloudflare 等几分钟,状态变成「有效」即可(会发邮件通知)

## 第 2 步:创建 KV 命名空间(存生成的 mp3)

1. 左侧「**Workers 和 Pages**」→「**KV**」→「**创建命名空间**」
2. 名称填 `voice-audio-kv`,创建

## 第 3 步:创建 Worker 并粘贴代码

1. 左侧「**Workers 和 Pages**」→「**创建**」→「**创建 Worker**」
2. 名字填 `voice-tts`,点「部署」(先随便部署一个模板,一会儿覆盖)
3. 点「**编辑代码**」,把编辑器里原有的内容**全部删掉**,粘贴 `worker.js` 的全部内容(文件在你的 ~/voice-clone/deploy-cloudflare/worker.js)
4. 点右上「**部署**」

## 第 4 步:配置 Worker 的变量和密钥

在 Worker 页面点「**设置**」→「**变量和机密**」:

**添加变量(普通,不是机密)**:
| 变量名 | 值 |
|---|---|
| `FISH_MODEL` | `s2.1-pro-free` |
| `PUBLIC_BASE_URL` | `https://你的域名`(如 https://voice.example.com,不带结尾斜杠) |

**添加机密(Secret)**:
| 名称 | 值 |
|---|---|
| `FISH_API_KEY` | `sk-fish-<your-api-key>`(在 https://fish.audio/app/api-keys 获取) |

**KV 绑定**:同页「KV 命名空间绑定」→「添加绑定」→ 变量名 `AUDIO_KV`,选 `voice-audio-kv`

## 第 5 步:绑定自定义域名

Worker 页面点「**设置**」→「**域和路由**」→「**添加**」→ 选「**自定义域**」→ 输入 `你的域名`(或子域名如 voice.你的域名)→ 添加。
等 1~2 分钟,访问 `https://你的域名/` 应该看到日语 API 说明页。

## 第 6 步:验证(在浏览器里)

1. `https://你的域名/api/v1/voices` → 返回你 Fish 账号里的声音列表(克洛普2 等)
2. `https://你的域名/openapi.json` → 返回扣子插件定义,servers.url 是你的域名
3. 合成测试:找一个 voice_id,访问
   `https://你的域名/api/v1/synthesize` 用 POST(可用浏览器插件或 Postman)body:
   `{"text":"こんにちは、テストです。","voice_id":"612c2426a32045c0a707c06509e9ecb6"}`
   应返回 `{"audio_url":"https://你的域名/audio/xxx.mp3",...}`,打开链接能播放

## 第 7 步:扣子接入

1. 扣子插件导入:下载 `https://你的域名/openapi-plugin.json` → 扣子导入插件
2. 或技能包:告诉我你的域名,我重新打包技能 zip
3. 本地 Mac 网站(http://localhost:8000)继续当你的"克隆工作台",克隆新声音后公开版自动可见(声音列表实时读 Fish 云端)

## 常见问题

- **voices 返回 502**:FISH_API_KEY 机密没配或配错
- **合成返回 502**:大概率是 Fish 侧报错,看返回的 detail
- **国内打不开你的域名**:Cloudflare 自定义域名国内通常可以但偶尔慢;你的主要用户在日​​本,不受影响
- **想换付费模型**:把 FISH_MODEL 变量改成 s2.1-pro(Fish 账号需有 API 余额)
