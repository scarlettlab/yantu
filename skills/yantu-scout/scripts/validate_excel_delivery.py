#!/usr/bin/env python3
"""Read-only verification of the actual XLSX package; no spreadsheet-library defaults."""
import argparse
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
RID = '{' + NS['r'] + '}id'
URL = re.compile(r'https?://[^\s<>"\u3000]+', re.I)
HYPERLINK = re.compile(r'^\s*(?:_xlfn\.)?HYPERLINK\(\s*"((?:[^"]|"")*)"\s*[,;]', re.I)


def address(value):
    match = re.fullmatch(r'\$?([A-Z]+)\$?(\d+)', value.upper())
    if not match:
        raise ValueError('Invalid cell address: ' + value)
    col = 0
    for c in match[1]:
        col = col * 26 + ord(c) - 64
    return col, int(match[2])


def area(value):
    ends = value.split(':')
    return (*address(ends[0]), *address(ends[-1]))


def column_name(col):
    result = ''
    while col:
        col, rem = divmod(col - 1, 26)
        result = chr(65 + rem) + result
    return result


def part_path(base, target):
    target = target.replace('\\', '/')
    resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else
                                 posixpath.join(posixpath.dirname(base), target))
    if resolved.startswith('../'):
        raise ValueError('Package target escapes root')
    return resolved


def relationships(z, part):
    relpath = (posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part)+'.rels')
               if part else '_rels/.rels')
    if relpath not in z.namelist():
        return {}
    return {item.get('Id'): dict(item.attrib) for item in ET.fromstring(z.read(relpath))}


def is_web_url(value):
    parsed = urlsplit(value)
    return parsed.scheme in ('https', 'http') and bool(parsed.netloc)


def inspect(path, spec=None):
    spec = spec or {}
    report = {'file': str(Path(path).resolve()), 'passed': False, 'errors': [], 'sheets': [],
              'scope': 'XLSX structure only; not clinical accuracy, full visual QA, or live URL availability'}

    def fail(message):
        report['errors'].append(message)

    with ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            fail('ZIP integrity failure: '+bad)
        root_rels = relationships(z, '')
        core_rels = [r for r in root_rels.values() if r.get('Type', '').endswith('/metadata/core-properties')]
        core_path = part_path('', core_rels[0]['Target']) if len(core_rels) == 1 else None
        if core_rels and (not core_path or core_path not in z.namelist()):
            fail('Invalid Core Properties part or package relationship')
        elif core_path:
            types = ET.fromstring(z.read('[Content_Types].xml'))
            if not any(t.get('PartName', '').lstrip('/') == core_path and
                       t.get('ContentType') == 'application/vnd.openxmlformats-package.core-properties+xml'
                       for t in types):
                fail('Core Properties content type missing or invalid')
            core = ET.fromstring(z.read(core_path))
            creator = core.findtext('{http://purl.org/dc/elements/1.1/}creator')
            modifier = core.findtext('{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastModifiedBy')
            report['metadata'] = {'creator': creator, 'lastModifiedBy': modifier}
        wb_rels = [r for r in root_rels.values() if r.get('Type', '').endswith('/officeDocument')]
        if len(wb_rels) != 1:
            raise ValueError('Workbook relationship missing or ambiguous')
        wb_path = part_path('', wb_rels[0]['Target'])
        wb = ET.fromstring(z.read(wb_path))
        wb_links = relationships(z, wb_path)
        shared = []
        for rel in wb_links.values():
            if rel.get('Type', '').endswith('/sharedStrings'):
                root = ET.fromstring(z.read(part_path(wb_path, rel['Target'])))
                shared = [''.join(n.itertext()) if n.tag.endswith('}t') else
                          ''.join(t.text or '' for t in n.findall('.//s:t', NS)) for n in root]
        seen = set()
        for item in wb.findall('s:sheets/s:sheet', NS):
            name = item.get('name')
            seen.add(name)
            config = spec.get('sheets', {}).get(name, {})
            sheet_path = part_path(wb_path, wb_links[item.get(RID)]['Target'])
            root = ET.fromstring(z.read(sheet_path))
            rels = relationships(z, sheet_path)
            cells = {}
            for cell in root.findall('s:sheetData/s:row/s:c', NS):
                value = cell.findtext('s:v', default='', namespaces=NS)
                text = (shared[int(value)] if cell.get('t') == 's' else
                        ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                        if cell.get('t') == 'inlineStr' else value)
                formula = cell.findtext('s:f', default='', namespaces=NS)
                if text or formula:
                    cells[cell.get('r')] = (text, formula)
                if cell.get('t') == 'e':
                    fail(f'{name}!{cell.get("r")}: Excel error {text}')
            sr = {'name': name, 'source_links_checked': 0}
            report['sheets'].append(sr)
            if config.get('summary_reason'):
                sr['freeze_filter_exception'] = config['summary_reason']
            else:
                panes = root.findall('s:sheetViews/s:sheetView/s:pane', NS)
                expected = config.get('freeze_cell')
                valid = False
                for pane in panes:
                    cell = pane.get('topLeftCell', '')
                    if not cell:
                        continue
                    col, row = address(cell)
                    if ((cell == expected if expected else cell in ('B2', 'C2')) and
                        pane.get('state') in ('frozen', 'frozenSplit') and
                        float(pane.get('xSplit', '0')) == col-1 and
                        float(pane.get('ySplit', '0')) == row-1):
                        valid = True
                        sr['freeze'] = cell
                if not valid:
                    fail(f'{name}: freeze must be {expected or "B2/C2"} with both row and column frozen')
                filters = list(root.findall('s:autoFilter', NS))
                for table in root.findall('s:tableParts/s:tablePart', NS):
                    rel = rels.get(table.get(RID), {})
                    if not rel.get('Target'):
                        continue
                    table_root = ET.fromstring(z.read(part_path(sheet_path, rel['Target'])))
                    filters.extend(table_root.findall('s:autoFilter', NS))
                expected_ranges = config.get('data_ranges')
                if expected_ranges is None:
                    coords = [address(a) for a in cells]
                    if not coords:
                        fail(f'{name}: empty data sheet; remove or justify summary exception')
                        expected_ranges = []
                    else:
                        expected_ranges = [f'A1:{column_name(max(c for c,r in coords))}{max(r for c,r in coords)}']
                sr['expected_filter_ranges'] = expected_ranges
                for expected_range in expected_ranges:
                    wanted = area(expected_range)
                    matching = [f for f in filters if f.get('ref') and area(f.get('ref')) == wanted]
                    if not matching:
                        fail(f'{name}: no actual autoFilter for {expected_range}')
                    elif any(c.get('hiddenButton') in ('1', 'true') or c.get('showButton') in ('0', 'false')
                             for c in matching[0].findall('s:filterColumn', NS)):
                        fail(f'{name}: filter dropdown disabled in {expected_range}')
            links = {}
            for h in root.findall('s:hyperlinks/s:hyperlink', NS):
                rel = rels.get(h.get(RID), {})
                if rel.get('Type', '').endswith('/hyperlink') and rel.get('TargetMode') == 'External':
                    target = rel.get('Target', '')
                    if is_web_url(target):
                        links[h.get('ref')] = target
                        sr['source_links_checked'] += 1
                    else:
                        fail(f'{name}!{h.get("ref")}: invalid web hyperlink target')
                elif h.get(RID):
                    fail(f'{name}!{h.get("ref")}: hyperlink relationship missing or invalid')
            for a, (value, formula) in cells.items():
                target = links.get(a)
                if 'HYPERLINK(' in formula.upper():
                    match = HYPERLINK.match(formula)
                    if not match or not is_web_url(match[1].replace('""', '"')):
                        fail(f'{name}!{a}: cannot verify HYPERLINK target; use explicit http/https URL or independently verify')
                    else:
                        target = match[1].replace('""', '"')
                        sr['source_links_checked'] += 1
                if URL.search(value):
                    if not target:
                        fail(f'{name}!{a}: plain-text source URL is not a clickable hyperlink')
                    elif is_web_url(value.strip()) and target != value.strip():
                        fail(f'{name}!{a}: displayed URL and hyperlink target differ')
        for unknown in set(spec.get('sheets', {}))-seen:
            fail('Configuration refers to nonexistent sheet: '+unknown)
    report['passed'] = not report['errors']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Optional --spec JSON: {"sheets":{"Data":{"freeze_cell":"B2","data_ranges":["A1:D10"]},"Summary":{"summary_reason":"Short narrative page with no data table"}}}. Exceptions require a real reason; omitted sheets use normal defaults. HYPERLINK formulas must use a literal http/https URL; other forms require equivalent manual verification.')
    parser.add_argument('xlsx')
    parser.add_argument('--spec', type=Path)
    args = parser.parse_args()
    try:
        report = inspect(args.xlsx, json.loads(args.spec.read_text()) if args.spec else None)
    except Exception as error:
        report = {'file': args.xlsx, 'passed': False, 'errors': [str(error)]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
