import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
import JSZip from 'jszip';

const FONT = '等线';
const TYPE_SET = new Set(['text', 'number', 'percent', 'date']);
const x = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const visualWidth = value => [...String(value)].reduce((n, c) => n + (/[^\u0000-\u00ff]/u.test(c) ? 2 : 1), 0);
const columnName = count => {
  let label = '';
  while (count) { count--; label = String.fromCharCode(65 + count % 26) + label; count = Math.floor(count / 26); }
  return label;
};

export function validate(spec) {
  if (!Array.isArray(spec.sheets) || !spec.sheets.length) throw Error('至少需要一个工作表');
  const names = new Set();
  for (const s of spec.sheets) {
    if (!s.name || s.name.length > 31 || /[\\/*?:\[\]]/.test(s.name) || names.has(s.name.toLowerCase())) throw Error('工作表名称无效或重复');
    names.add(s.name.toLowerCase());
    if (!Array.isArray(s.columns) || !s.columns.length || s.columns.length > 16384) throw Error('列定义无效');
    if (!Array.isArray(s.rows) || s.rows.length > 1048575) throw Error('行数超过Excel限制');
    if (!s.columns.every(c => typeof c.name === 'string' && c.name.trim() && TYPE_SET.has(c.type ?? 'text'))) throw Error('列名或数据类型无效');
    if (new Set(s.columns.map(c => c.name)).size !== s.columns.length) throw Error('列名重复');
    const freezeColumns = s.freezeColumns ?? 1;
    if (!Number.isInteger(freezeColumns) || freezeColumns < 1 || freezeColumns > Math.min(2, s.columns.length)) throw Error('冻结列数必须为1或2');
    for (const c of s.columns) if (c.width !== undefined && (!Number.isFinite(c.width) || c.width < 12 || c.width > 80)) throw Error('列宽须在12–80之间');
    for (const row of s.rows) if (!Array.isArray(row) || row.length !== s.columns.length) throw Error('数据行与列定义数量不一致');
  }
}

function cellValue(raw, column) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
  const value = item.value;
  if (item.url) {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw Error('来源链接仅接受http/https');
  }
  if (value === null || value === undefined) return { value: null };
  if (typeof value === 'string' && value.length > 32767) throw Error('单元格过长，请用稳定研究编号拆入明细表');
  if ((column.type === 'number' || column.type === 'percent') && typeof value !== 'number') {
    if (!['未公开', '不适用', '未读取', '未核实', '技术失败', '未检索到客观数据'].includes(value)) throw Error('数值列需要JSON数值或明确缺失状态');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('数值必须有限');
  if (column.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw Error('日期无效');
    return { value: date };
  }
  const text = typeof value === 'string' && value.startsWith('=') ? "'" + value : value;
  return { value: (column.type ?? 'text') === 'text' ? String(text) : text, url: item.url };
}

export async function build(spec, outputPath, previewDir) {
  validate(spec);
  const workbook = Workbook.create();
  const configs = [];
  for (const [index, specSheet] of spec.sheets.entries()) {
    const sheet = workbook.worksheets.add(specSheet.name);
    const cols = specSheet.columns;
    const cells = specSheet.rows.map(row => row.map((v, c) => cellValue(v, cols[c])));
    const values = [cols.map(c => c.name), ...cells.map(row => row.map(c => c.value))];
    const full = sheet.getRangeByIndexes(0, 0, values.length, cols.length);
    full.values = values;
    full.format.font = { name: FONT, size: 11, color: '#243442' };
    full.format.wrapText = true;
    full.format.verticalAlignment = 'top';
    full.format.horizontalAlignment = 'left';
    sheet.showGridLines = false;
    sheet.freezePanes.freezeRows(1);
    sheet.freezePanes.freezeColumns(specSheet.freezeColumns ?? 1);
    for (let c = 0; c < cols.length; c++) {
      const col = sheet.getRangeByIndexes(0, c, values.length, 1);
      const type = cols[c].type ?? 'text';
      col.format.columnWidth = cols[c].width ?? (c === 0 ? 22 : type === 'text' ? 36 : 18);
      if (values.length > 1) {
        const body = sheet.getRangeByIndexes(1, c, values.length - 1, 1);
        body.setNumberFormat(cols[c].numberFormat ?? ({ text: '@', number: 'General', percent: '0.0%', date: 'yyyy-mm-dd' })[type]);
        if (type === 'number' || type === 'percent') body.format.horizontalAlignment = 'right';
        if (type === 'text' && (cols[c].width ?? 36) <= 18) body.format.horizontalAlignment = 'center';
      }
    }
    const header = sheet.getRangeByIndexes(0, 0, 1, cols.length);
    header.format.fill = '#314B5B';
    header.format.font = { name: FONT, size: 12, bold: true, color: '#FFFFFF' };
    header.format.horizontalAlignment = 'center';
    header.format.verticalAlignment = 'center';
    header.format.rowHeight = 36;
    for (let r = 1; r < values.length; r++) {
      const row = sheet.getRangeByIndexes(r, 0, 1, cols.length);
      row.format.fill = r % 2 ? '#FFFFFF' : '#F2F6F8';
      let lines = 1;
      for (let c = 0; c < cols.length; c++) {
        const value = specSheet.rows[r - 1][c];
        const display = value && typeof value === 'object' ? value.value : value;
        const width = cols[c].width ?? (c === 0 ? 22 : (cols[c].type ?? 'text') === 'text' ? 36 : 18);
        lines = Math.max(lines, String(display ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(visualWidth(line) / Math.max(8, width - 3))), 0));
        if (cells[r - 1][c].url) {
          sheet.getCell(r, c).format.font.color = '#215F87';
        }
      }
      const height = Math.max(28, lines * 16 + 10);
      if (height > 409) throw Error(`工作表${specSheet.name}第${r + 1}行过长，请按研究编号拆入明细表`);
      row.format.rowHeight = height;
    }
    const links = cells.flatMap((row, r) => row.flatMap((cell, c) => cell.url ? [{ ref: columnName(c + 1) + (r + 2), url: cell.url }] : []));
    configs.push({ name: specSheet.name, rows: values.length, cols: cols.length, freezeColumns: specSheet.freezeColumns ?? 1, index, links });
  }
  workbook.recalculate();
  const check = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 30 }, maxChars: 1500 });
  console.log(check.ndjson);
  if (previewDir) {
    await fs.mkdir(previewDir, { recursive: true });
    for (const c of configs) {
      const range = workbook.worksheets.getItem(c.name).getRangeByIndexes(0, 0, Math.min(c.rows, 6), Math.min(c.cols, 6));
      const preview = await workbook.render({ sheetName: c.name, range: range.address.split('!').at(-1), scale: 1.5, format: 'png' });
      await fs.writeFile(path.join(previewDir, `sheet-${c.index + 1}.png`), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const file = await SpreadsheetFile.exportXlsx(workbook);
  await file.save(outputPath);
  // Add package properties and a plain filter without introducing a Table style.
  const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
  for (const c of configs) {
    const fileName = `xl/worksheets/sheet${c.index + 1}.xml`;
    let xml = await zip.file(fileName).async('string');
    const prefix = xml.match(/<([\w]+:)?worksheet\b/)[1] ?? '';
    let elements = `<${prefix}autoFilter ref="A1:${columnName(c.cols)}${c.rows}"/>`;
    if (c.links.length) {
      const relName = `xl/worksheets/_rels/sheet${c.index + 1}.xml.rels`;
      let sheetRels = zip.file(relName) ? await zip.file(relName).async('string') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      elements += `<${prefix}hyperlinks>`;
      c.links.forEach((link, n) => {
        const id = `scoutLink${n + 1}`;
        elements += `<${prefix}hyperlink ref="${link.ref}" r:id="${id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>`;
        sheetRels = sheetRels.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(link.url)}" TargetMode="External"/></Relationships>`);
      });
      elements += `</${prefix}hyperlinks>`;
      zip.file(relName, sheetRels);
    }
    xml = xml.replace(`</${prefix}sheetData>`, `</${prefix}sheetData>${elements}`);
    zip.file(fileName, xml);
  }
  // Preserve metadata provided by the exporter; do not set an author.
  if (!zip.file('docProps/core.xml')) {
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(spec.title ?? '研途Scout研究表')}</dc:title><dc:description>研途Scout v3.6.4</dc:description></cp:coreProperties>`);
  }
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  if (!contentTypes.includes('/docProps/core.xml')) contentTypes = contentTypes.replace('</Types>', '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('[Content_Types].xml', contentTypes);
  let rels = await zip.file('_rels/.rels').async('string');
  if (!rels.includes('metadata/core-properties')) rels = rels.replace('</Relationships>', '<Relationship Id="scoutCoreProperties" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('_rels/.rels', rels);
  await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const auditor = fileURLToPath(new URL('./validate_excel_delivery.py', import.meta.url));
  const audit = spawnSync(process.env.SCOUT_PYTHON || 'python3', [auditor, outputPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (audit.error) throw Error(`最终XLSX结构检查无法运行：${audit.error.message}；不能宣称检查通过`);
  let report;
  try { report = JSON.parse(audit.stdout); }
  catch { throw Error(`最终XLSX结构检查未返回有效结果：${audit.stderr || audit.stdout}`); }
  await fs.writeFile(outputPath + '.qc.json', JSON.stringify(report, null, 2) + '\n');
  if (audit.status !== 0 || !report.passed) throw Error('最终XLSX结构检查失败：' + report.errors.join('; '));
  console.log(JSON.stringify({ output: outputPath, scoutVersion: '3.6.4', structureVerified: true, sheets: configs }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , input, output, preview] = process.argv;
  if (!input || !output) throw Error('用法：node build_excel_report.mjs input.json output.xlsx [preview-directory]');
  await build(JSON.parse(await fs.readFile(input, 'utf8')), output, preview);
}
