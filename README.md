# 日语声音克隆网站(声クローン)

把自己喜欢的日语声音录下来 → 用 [Fish Audio](https://fish.audio) 克隆成声音模型 → 输入日语文本生成语音,并可打包成扣子(coze.cn)插件使用。

## 功能

- 🎙 **录音 / 上传克隆**:浏览器直接录音(或上传 1~3 个音频文件),一键克隆声音
- 📚 **声音库**:本地管理所有克隆声音,试听、与云端同步、删除
- 🗣 **语音合成**:输入日语文本,用克隆声音生成 mp3,在线播放 / 下载
- 🧩 **扣子插件**:一键下载 OpenAPI 插件包,导入扣子后 Bot 可直接调用生成语音

## 快速开始

### 0. 准备

1. 注册 [Fish Audio](https://fish.audio),在 [API Keys 页面](https://fish.audio/app/api-keys) 创建 API Key
2. 安装 ffmpeg:`brew install ffmpeg`(录音转码用)

### 1. 安装依赖

```bash
cd ~/voice-clone
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`,填入你的 `FISH_API_KEY`。

### 3. 启动

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

浏览器打开 **http://localhost:8000**,开始使用:
① 克隆声音 → 录音或上传(≥10 秒,单人安静环境)→ 命名 → 克隆
② 声音库 → 查看 / 试听 / 同步 / 删除
③ 语音合成 → 选声音 → 输入日语文本 → 生成

## 装到扣子(coze.cn)

扣子的插件接口必须是**公网 HTTPS 地址**,本地跑的时候用内网穿透:

```bash
# 安装 cpolar(推荐,国内节点;ngrok 也行)
brew install cpolar
cpolar http 8000
```

拿到形如 `https://xxxx.cpolar.top` 的域名后:

1. 改 `.env`:`PUBLIC_BASE_URL=https://xxxx.cpolar.top`,重启网站
2. 打开网站 → 「④ 扣子插件」→ 下载插件包 `voice-tts-plugin.json`
3. 扣子 → 资源库 → +资源 → 插件 → 导入插件 → 上传 JSON
4. 试运行:输入日语文本 + voice_id(用 voices 工具先查)→ 验证返回的音频链接可播放
5. 发布插件 → 创建 Bot → 添加插件 → Bot 会用 `synthesize` 工具合成语音,以 Markdown 链接发给用户

> 注意:cpolar 免费版域名随机且限速,重启隧道后域名可能变化,需要重新下载并导入插件。长期使用建议部署到云服务器 + 自有域名。

## 插件工具说明

| 工具 | 说明 |
|---|---|
| `synthesize` | 输入 `text`(日语,≤500 字)+ `voice_id`,返回 `{audio_url, duration, voice_id}` |
| `voices` | 列出所有克隆声音,返回 `voice_id` 列表 |

## 常见问题

- **克隆效果不好**:样本要 ≥10 秒、单人、安静、无背景音乐;20~60 秒效果更好
- **合成失败 502**:大多是 Fish 侧报错(额度不足 / 样本不达标),错误详情会显示在页面提示里
- **扣子调用超时**:文本太长了,500 字以内;或网络链路问题(扣子 → 你的隧道 → Fish)
- **改了 PUBLIC_BASE_URL 后扣子还用不了**:需要重新下载插件 JSON 并重新导入(扣子导入后 URL 不可修改)
