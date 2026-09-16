import os, sys
sys.stdout.reconfigure(encoding='utf-8')

def purge(path):
    """file-by-file delete (shim-safe), then bottom-up dir removal"""
    ok, fail = 0, []
    for root, dirs, files in os.walk(path, topdown=False):
        for f in files:
            p = os.path.join(root, f)
            try:
                os.remove(p); ok += 1
            except Exception as e:
                fail.append(p)
        for d in dirs:
            p = os.path.join(root, d)
            try:
                os.rmdir(p)
            except Exception:
                pass
    try:
        os.rmdir(path)
        return ok, fail, True
    except Exception:
        return ok, fail, False

for target in [r'E:\T-Minus\apps\windows\rb_tmp', r'E:\T-Minus\apps\windows\release25']:
    if not os.path.exists(target):
        print('GONE:', target)
        continue
    ok, fail, removed = purge(target)
    print(('PURGED' if removed else 'PARTIAL'), target, f'({ok} files, {len(fail)} failed)')
    for p in fail[:5]:
        print('  FAIL:', p)
