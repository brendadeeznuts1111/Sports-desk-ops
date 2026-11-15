#!/usr/bin/env python3
"""Deterministic content manifest of a directory tree (Bun-free on purpose).

One line per entry, sorted by path bytes:  <type> <mode> <sha256|link-target> <relpath>
  type f=file l=symlink d=dir ; mode is 755/644 for files (exec bit only), - otherwise.
mtimes, owners, inode order and absolute paths are excluded, so two installs that put the
same bytes at the same paths produce the same manifest. Prints the manifest's own sha256
on stderr (or only that with --digest).

  python3 scripts/supply-chain/tree_manifest.py node_modules > nm.manifest
  python3 scripts/supply-chain/tree_manifest.py --digest node_modules
  --exclude NAME   skip entries whose basename is NAME (repeatable), e.g. .cache
"""
import hashlib, os, stat, sys

def main(argv):
    digest_only = False; excludes = set(); root = None
    it = iter(argv)
    for a in it:
        if a == "--digest": digest_only = True
        elif a == "--exclude": excludes.add(next(it))
        else: root = a
    if not root: print(__doc__, file=sys.stderr); return 2
    lines = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in excludes]
        for name in dirnames + filenames:
            if name in excludes: continue
            p = os.path.join(dirpath, name); rel = os.path.relpath(p, root)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                lines.append(f"l - {os.readlink(p)} {rel}")
            elif stat.S_ISDIR(st.st_mode):
                lines.append(f"d - - {rel}")
            elif stat.S_ISREG(st.st_mode):
                h = hashlib.sha256()
                with open(p, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
                mode = "755" if st.st_mode & 0o111 else "644"
                lines.append(f"f {mode} {h.hexdigest()} {rel}")
            else:
                lines.append(f"? - - {rel}")
    lines.sort(key=lambda s: s.split(" ", 3)[3].encode())
    body = ("\n".join(lines) + "\n").encode()
    d = hashlib.sha256(body).hexdigest()
    if digest_only: print(d)
    else:
        sys.stdout.buffer.write(body)
        print(f"manifest-sha256 {d} entries={len(lines)}", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
