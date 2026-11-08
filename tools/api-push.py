#!/usr/bin/env python3
"""通过 GitHub Git Data API 推送初始提交（github.com:443 不可达时的替代路径）。
从 macOS 钥匙串读取凭据；blob→tree→commit→ref 四步。"""
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error

REPO = "1217776385l-ctrl/737-flight-simulator"
ROOT = "/Users/abagnale-lyu/Desktop/自己做的游戏/飞行模拟器"
EXCLUDE_DIRS = {".git", "node_modules", ".zcode-site", ".zcode"}
EXCLUDE_FILES = {".DS_Store", "package-lock.json"}

cred = subprocess.run(
    ["git", "credential-osxkeychain", "get"], input="protocol=https\nhost=github.com\n",
    capture_output=True, text=True).stdout
TOKEN = next(l.split("=", 1)[1] for l in cred.splitlines() if l.startswith("password="))
API = f"https://api.github.com/repos/{REPO}"
HDR = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
       "User-Agent": "api-push"}


def api(path, payload=None, method=None, binary=False):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data,
                                 headers={**HDR, "Content-Type": "application/json"},
                                 method=method or ("POST" if data else "GET"))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code == 404 and data is not None and attempt < 3:
                print(f"  404 瞬态重试 {attempt+1}: {path}"); time.sleep(6 * (attempt + 1)); continue
            if e.code < 500 and e.code != 403:
                raise RuntimeError(f"{e.code} {path}: {body[:300]}")
            if e.code == 403 and "rate limit" in body.lower():
                print(f"  rate limit, 等待 60s..."); time.sleep(60); continue
            raise RuntimeError(f"{e.code} {path}: {body[:300]}")
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  网络重试 {attempt+1}: {e}"); time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{path}: 重试耗尽")


import hashlib
CACHE = "/tmp/gh-blob-cache.json"
cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}

# 收集文件
files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
    for fn in filenames:
        if fn in EXCLUDE_FILES or fn == ".DS_Store":
            continue
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
        if rel.startswith(".github/"):
            continue  # workflow 文件需要 token 的 workflow scope，当前钥匙串凭据没有——排除
        files.append((rel, full))
files.sort()
print(f"共 {len(files)} 个文件")

tree = []
for i, (rel, full) in enumerate(files, 1):
    with open(full, "rb") as f:
        raw = f.read()
    mode = "100755" if (os.stat(full).st_mode & 0o111) else "100644"
    key = rel + ":" + hashlib.sha1(raw).hexdigest()[:12] + ":" + str(len(raw))
    if key in cache:
        print(f"[{i}/{len(files)}] {rel} (cache)")
        tree.append({"path": rel, "mode": mode, "type": "blob", "sha": cache[key]})
        continue
    blob = api("/git/blobs", {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
    cache[key] = blob["sha"]; json.dump(cache, open(CACHE, "w"))
    tree.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
    size = len(raw)
    print(f"[{i}/{len(files)}] {rel} ({size//1024} KB) -> {blob['sha'][:10]}")

# Pages(分支式, /docs 源)：给 sim/ 内容加一份 docs/ 镜像（同 blob，零额外上传）
sim_entries = [e for e in tree if e["path"].startswith("sim/")]
for e in sim_entries:
    tree.append({**e, "path": "docs/" + e["path"][4:]})
tr = api("/git/trees", {"tree": tree})
print(f"tree: {tr['sha'][:10]}")

commit = api("/git/commits", {
    "message": "737-800 flight simulator: cockpit, 14 emergency scenarios, 5-airport routes, nav system, scoring — made by LYU",
    "tree": tr["sha"],
    "parents": [api("/git/ref/heads/main")["object"]["sha"]]})
print(f"commit: {commit['sha'][:10]}")

# main 已存在（Contents API 初始化的提交）→ PATCH 快进；否则 POST 创建
try:
    cur = api("/git/ref/heads/main")
    upd = api("/git/refs/heads/main", {"sha": commit["sha"], "force": False}, method="PATCH")
    print(f"ref main PATCH -> {upd['object']['sha'][:10]}")
except RuntimeError as e:
    if "404" in str(e):
        ref = api("/git/refs", {"ref": "refs/heads/main", "sha": commit["sha"]})
        print(f"ref main POST -> {ref['object']['sha'][:10]}")
    else:
        raise
print("DONE: https://github.com/" + REPO)
