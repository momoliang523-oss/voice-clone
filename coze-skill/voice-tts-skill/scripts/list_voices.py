#!/usr/bin/env python3
"""列出 VoiceTTS 上所有可用克隆声音(纯标准库,无第三方依赖)。

用法: python list_voices.py
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "https://ryomomo.top"


def main() -> None:
    req = urllib.request.Request(f"{BASE}/api/v1/voices")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for v in data.get("voices", []):
                print(f"{v['voice_id']}  {v['title']}  [{v.get('state', '')}]")
    except urllib.error.HTTPError as e:
        print(json.dumps({"error": e.read().decode("utf-8"), "status": e.code}, ensure_ascii=False))
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": f"网络错误: {e.reason}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
