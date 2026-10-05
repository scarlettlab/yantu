"""Copy standalone skills and license notices; never overwrite an existing skill."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
NAMES = ('atlas', 'scout', 'guide', 'trace', 'frame', 'draft')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--skill', choices=NAMES)
    choice.add_argument('--all', action='store_true')
    parser.add_argument('--destination', type=Path, default=Path.home() / '.agents/skills')
    args = parser.parse_args()
    names = NAMES if args.all else (args.skill,)
    sources = [ROOT / 'skills' / ('yantu-' + name) for name in names]
    targets = [args.destination / source.name for source in sources]
    for source, target in zip(sources, targets):
        if not (source / 'SKILL.md').is_file():
            parser.error('Missing source skill: ' + source.name)
        if target.exists() or target.is_symlink():
            parser.error('Refusing to overwrite existing skill: ' + str(target))
    args.destination.mkdir(parents=True, exist_ok=True)
    for source, target in zip(sources, targets):
        shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
            shutil.copyfile(ROOT / name, target / name)
        print('Installed ' + str(target))


if __name__ == '__main__':
    main()
