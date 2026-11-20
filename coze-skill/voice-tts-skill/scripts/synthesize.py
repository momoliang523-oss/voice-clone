#!/usr/bin/env python3
"""调用 VoiceTTS 合成语音(纯标准库,无第三方依赖)。

用法: python synthesize.py <voice_id> <text>
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "https://ryomomo.top"


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "用法: python synthesize.py <voice_id> <text>"}, ensure_ascii=False))
        sys.exit(1)
    voice_id, text = sys.argv[1], sys.argv[2]
    req = urllib.request.Request(
        f"{BASE}/api/v1/synthesize",
        data=json.dumps({"text": text, "voice_id": voice_id}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(json.dumps({"error": e.read().decode("utf-8"), "status": e.code}, ensure_ascii=False))
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({"error": f"网络错误: {e.reason}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
