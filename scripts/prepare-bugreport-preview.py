from pathlib import Path
import json, re

def replace(name, old, new):
    p = Path(name)
    text = p.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise RuntimeError('Patch anchor missing or ambiguous: ' + name + ': ' + old)
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

look = 'renderer/app/21-look.js'
replace(look, '  typoKeep: 0,', '  exportNumbers: false,\n  typoKeep: 0,')
replace(look, "    if (typeof raw.typoLayout === 'boolean')", "    if (typeof raw.exportNumbers === 'boolean') s.exportNumbers = raw.exportNumbers;\n    if (typeof raw.typoLayout === 'boolean')")
replace(look, "  $('#setPara').value = settings.para;", "  $('#setPara').value = settings.para;\n  $('#setExportNumbers').checked = settings.exportNumbers;")
replace('renderer/app/25-sound.js', "  bindSetting('#setPara', 'para', (el) => el.value);", "  bindSetting('#setPara', 'para', (el) => el.value);\n  bindSetting('#setExportNumbers', 'exportNumbers', (el) => el.checked);")
replace('renderer/index.html', '      <h3>Дополнительно</h3>', '      <h3>Дополнительно</h3>\n      <div class="row">\n        <label for="setExportNumbers">Нумеровать главы при экспорте</label>\n        <input id="setExportNumbers" type="checkbox">\n      </div>')
pattern = re.compile(r"api\.exportProject\(\{\s*indent:\s*settings\.para === 'indent'\s*\}\)")
hits = []
for p in Path('renderer/app').glob('*.js'):
    text = p.read_text(encoding='utf-8')
    hits.extend((p, m.group(0)) for m in pattern.finditer(text))
if len(hits) != 1:
    raise RuntimeError('Expected one renderer export call; refusing to guess')
p, old = hits[0]
replace(str(p), old, "api.exportProject({ indent: settings.para === 'indent', chapterNumbers: settings.exportNumbers === true })")
for name in ['main.js', 'mobile/backend.js']:
    replace(name, 'const exportOpts = { indent: !!(opts && opts.indent) };', 'const exportOpts = { indent: !!(opts && opts.indent), chapterNumbers: !!(opts && opts.chapterNumbers === true) };')
replace('main.js', "exporter.buildExport(dir, 'docx', i18n.getLang())", "exporter.buildExport(dir, 'docx', i18n.getLang(), exportOpts)")
replace('mobile/backend.js', "fmt === 'docx' ? undefined : exportOpts", 'exportOpts')
replace('src/i18n-dictionary.js', "  ...require('./i18n-en'),", "  ...require('./i18n-en'),\n  'Нумеровать главы при экспорте': 'Number chapters on export',")
p = Path('package.json')
text = p.read_text(encoding='utf-8')
command = json.loads(text)['scripts']['test']
if 'test/preview-export.test.js' in command:
    raise RuntimeError('Preview test already registered')
replace(str(p), json.dumps(command, ensure_ascii=False), json.dumps(command + ' test/preview-export.test.js', ensure_ascii=False))
