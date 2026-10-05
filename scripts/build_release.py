"""Build source, plugin and independent skill ZIPs from the single skills source."""
import hashlib
import json
from pathlib import Path
import zipfile
from validate_release import ROOT, EXCLUDED, source_files, validate


def archive(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for source, name in entries:
            info = zipfile.ZipInfo(name, (2026, 10, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, source.read_bytes())
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        assert len(z.namelist()) == len(set(z.namelist()))
        for source, name in entries:
            assert z.read(name) == source.read_bytes()


def main():
    result = validate()
    version = json.loads((ROOT / 'plugin.json').read_text())['version']
    dest = ROOT / 'dist'
    dest.mkdir(exist_ok=True)
    files = list(source_files())
    outputs = []
    source_zip = dest / f'yantu-source-{version}.zip'
    archive(source_zip, [(p, 'yantu/' + str(p.relative_to(ROOT))) for p in files])
    outputs.append(source_zip)
    # Both entry points contain the canonical source so all documentation links and checks work.
    plugin_files = files
    plugin_zip = dest / f'yantu-plugin-{version}.zip'
    archive(plugin_zip, [(p, 'yantu/' + str(p.relative_to(ROOT))) for p in plugin_files])
    outputs.append(plugin_zip)
    for skill in sorted(p for p in (ROOT / 'skills').iterdir() if p.is_dir() and p.name not in EXCLUDED):
        entries = [(p, str(p.relative_to(skill.parent))) for p in files if p.is_relative_to(skill)]
        entries += [(ROOT / name, skill.name + '/' + name) for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md')]
        target = dest / f'{skill.name}-{version}.zip'
        archive(target, entries)
        outputs.append(target)
    (dest / 'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in outputs))
    print(json.dumps({'validation': result, 'archives': [p.name for p in outputs]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
