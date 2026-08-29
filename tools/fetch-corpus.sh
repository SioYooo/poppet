#!/bin/sh
# 重新取闸门语料。图片不入库，只在 assets/corpus/manifest.json 里记来源与校验和。
set -e
cd "$(dirname "$0")/.."
mkdir -p assets/corpus/raw
cd assets/corpus/raw
[ -f dcss.zip ] || curl -sSL -o dcss.zip "https://opengameart.org/sites/default/files/crawl-tiles%20Oct-5-2010.zip"
shasum -a 256 dcss.zip
unzip -q -o dcss.zip -d dcss
echo "解开到 assets/corpus/raw/dcss/  （CC0，来源见 manifest.json）"
