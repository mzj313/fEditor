#!/usr/bin/env python3
"""从 ECDICT 原始 CSV 生成精简离线英汉词典。

用法：
    python3 scripts/build-dict.py [ecdict.csv 路径]

输出：
    src-tauri/resources/dict-en-zh.json.gz

原始数据来源：ECDICT（https://github.com/skywind3000/ECDICT，MIT License）。
这里只保留高频与考试核心词，压缩后约 1–3 MB，随应用一起打包。
"""

import csv
import gzip
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "resources" / "dict-en-zh.json.gz"
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/ecdict.csv")

WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\- ]{0,29}$")
FREQ_LIMIT = 50000
COURSE_TAGS = ("zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre")


def clean_translation(text: str) -> str:
    """把换行分隔的释义压成一行，去掉过长的例句与重复内容。"""
    text = text.replace("\\n", "；").replace("\r", "").replace("\n", "；")
    parts = [part.strip(" ；;") for part in text.split("；")]
    seen = []
    for part in parts:
        if part and part not in seen:
            seen.append(part)
    joined = "；".join(seen)
    return joined[:200]


def keep(row: dict) -> bool:
    word = (row.get("word") or "").strip()
    translation = (row.get("translation") or "").strip()
    if not word or not translation or not WORD_RE.match(word):
        return False

    try:
        frq = int(row.get("frq") or 0)
    except ValueError:
        frq = 0
    try:
        bnc = int(row.get("bnc") or 0)
    except ValueError:
        bnc = 0

    if 0 < frq <= FREQ_LIMIT or 0 < bnc <= FREQ_LIMIT:
        return True
    if (row.get("oxford") or "").strip() == "1":
        return True
    try:
        if int(row.get("collins") or 0) > 0:
            return True
    except ValueError:
        pass
    tags = (row.get("tag") or "").split()
    return any(tag in COURSE_TAGS for tag in tags)


def main() -> None:
    if not SRC.exists():
        sys.exit(f"找不到原始词典：{SRC}")

    entries: dict[str, dict] = {}
    total = 0
    with SRC.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            total += 1
            if not keep(row):
                continue
            word = row["word"].strip()
            key = word.lower()
            if key in entries:
                continue
            entries[key] = {
                "w": word,
                "p": (row.get("phonetic") or "").strip(),
                "t": clean_translation(row["translation"]),
            }

    data = sorted(entries.values(), key=lambda item: item["w"].lower())
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(OUT, "wb", compresslevel=9) as handle:
        handle.write(payload)

    size_kb = OUT.stat().st_size / 1024
    print(f"扫描 {total} 行，保留 {len(data)} 词条")
    print(f"输出 {OUT}：{size_kb:.0f} KB（未压缩 {len(payload) / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
