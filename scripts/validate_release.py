"""Validate package boundaries, contained links, references and personal-config exclusions."""
import ast
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', 'dist', 'node_modules', '__pycache__', '.wrangler', '.DS_Store'}


def source_files():
    for p in sorted(ROOT.rglob('*')):
        if any(part in EXCLUDED for part in p.relative_to(ROOT).parts):
            continue
        if p.is_symlink():
            raise AssertionError('Symlink in source: ' + str(p.relative_to(ROOT)))
        if p.is_file():
            yield p


def validate():
    files = list(source_files())
    manifest = json.loads((ROOT / 'plugin.json').read_text())
    assert manifest['name'] == 'yantu'
    assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?', manifest['version'])
    assert len(manifest['extensions']['com.openai']['interface']['shortDescription']) <= 30
    assert not any((ROOT / n).exists() for n in ('.app.json', 'mcp.json', '.mcp.json'))
    skills = sorted(p for p in (ROOT / 'skills').iterdir() if p.is_dir() and p.name not in EXCLUDED)
    assert len(skills) == 6
    references = 0
    for folder in skills:
        entry = folder / 'SKILL.md'
        text = entry.read_text()
        assert text.startswith('---\nname: ' + folder.name + '\n')
        assert 'description:' in text.split('---', 2)[1]
        assert '药物临床研发' in text
        assert '../../' not in text and '../scout/' not in text
        for path in re.findall(r'(?:references|scripts|examples)/[^\s`、，；）)\]]+\.(?:txt|md|mjs|py|json)', text):
            assert (folder / path).is_file(), (entry, path)
            references += 1
    # Generic connection/credential patterns only; never embed a real user's identifiers in a public validator.
    prohibited = re.compile(r'/Users/|[A-Z]:\\Users\\|plugins_[a-f0-9]{12}|asdk_app_|\.workers\.dev|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9]{20,}')
    for p in files:
        rel = p.relative_to(ROOT)
        assert p.suffix.lower() not in ('.xlsx', '.xls', '.pdf', '.docx', '.zip', '.pyc'), str(rel)
        assert p.name not in ('.DS_Store', '.env', '.dev.vars'), str(rel)
        if p.suffix in ('.json', '.jsonc'):
            json.loads(p.read_text())
        if p.suffix == '.py':
            ast.parse(p.read_text())
        text = p.read_text(encoding='utf-8')
        # This validator contains the search expressions themselves.
        if p != Path(__file__).resolve():
            assert not prohibited.search(text), 'Private configuration pattern in ' + str(rel)
        if p.suffix == '.md':
            for link in re.findall(r'\]\(([^)]+)\)', text):
                if '://' in link or link.startswith('#') or link == 'URL':
                    continue
                target = (p.parent / link.split('#')[0]).resolve()
                assert target.is_relative_to(ROOT), ('outside repository', rel, link)
                assert target.exists(), ('broken link', rel, link)
    for p in files:
        if p.is_relative_to(ROOT / 'skills'):
            t = p.read_text()
            assert not re.search(r'必须且只能.*Action|禁止使用浏览工具访问 clinicaltrials', t)
            assert '知识库已包含' not in t
    return {'status': 'passed', 'source_files': len(files), 'skills': len(skills), 'entry_resource_links': references,
            'personal_connection': 'none', 'dictionary_binaries': 'none', 'root_mcp': 'none'}


if __name__ == '__main__':
    print(json.dumps(validate(), ensure_ascii=False, indent=2))
