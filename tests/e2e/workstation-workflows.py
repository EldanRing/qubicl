"""Small real save/open/export fixtures for the five workstation applications.

Run in a disposable workstation as its workload user, with a live DISPLAY.
Outputs stay in the specified home directory; no existing documents are used.
"""
import argparse
import json
from pathlib import Path
import subprocess
import textwrap
import zipfile
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--only', nargs='+', choices=['inkscape', 'gimp', 'blender', 'freecad', 'kdenlive'])
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)

def run(app, command, timeout=90):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, timeout=timeout)
    (out / f'{app}.log').write_text(result.stdout)
    if result.returncode:
        raise RuntimeError(f'{app} exited {result.returncode}: {result.stdout[-2000:]}')

def verify(app, source, exports):
    for path in [source, *exports]:
        if not path.is_file() or not path.stat().st_size:
            raise AssertionError(f'{app} did not create {path}')
    print(json.dumps({'app': app, 'source': str(source), 'exports': [str(p) for p in exports], 'saveOpenExport': True}), flush=True)

def inkscape():
    svg = out / 'fixture.svg'
    svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3478f6"/></svg>')
    for fmt in ['png', 'pdf']:
        run('inkscape-' + fmt, ['inkscape', str(svg), '--export-type=' + fmt, '--export-filename=' + str(out / ('inkscape.' + fmt))])
    assert (out / 'inkscape.png').read_bytes().startswith(b'\x89PNG')
    assert (out / 'inkscape.pdf').read_bytes().startswith(b'%PDF')
    verify('inkscape', svg, [out / 'inkscape.png', out / 'inkscape.pdf'])


def gimp():
    script = out / 'gimp-fixture.py'
    script.write_text(textwrap.dedent(f'''
    from gi.repository import Gimp, Gio
    image = Gimp.Image.new(64, 64, Gimp.ImageBaseType.RGB)
    layer = Gimp.Layer.new(image, 'Fixture', 64, 64, Gimp.ImageType.RGB_IMAGE, 100, Gimp.LayerMode.NORMAL)
    image.insert_layer(layer, None, 0)
    layer.fill(Gimp.FillType.WHITE)
    for name, filename in [('gimp-xcf-save', {str(out / 'fixture.xcf')!r}), ('file-png-export', {str(out / 'gimp.png')!r})]:
        proc = Gimp.get_pdb().lookup_procedure(name)
        config = proc.create_config()
        config.set_property('run-mode', Gimp.RunMode.NONINTERACTIVE)
        config.set_property('image', image)
        config.set_property('file', Gio.File.new_for_path(filename))
        result = proc.run(config)
        assert result.index(0) == Gimp.PDBStatusType.SUCCESS, str(result.index(0))
    reopened = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path({str(out / 'fixture.xcf')!r}))
    assert reopened.get_width() == 64 and len(reopened.get_layers()) == 1
    '''))
    run('gimp', ['gimp', '--no-interface', '--no-splash', '--batch-interpreter=python-fu-eval', '--batch=' + f'exec(open({str(script)!r}).read())', '--quit'])
    assert (out / 'gimp.png').read_bytes().startswith(b'\x89PNG')
    verify('gimp', out / 'fixture.xcf', [out / 'gimp.png'])


def blender():
    script = out / 'blender-fixture.py'
    script.write_text(textwrap.dedent(f'''
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.render.resolution_x = scene.render.resolution_y = 32
    scene.render.resolution_percentage = 100
    scene.render.filepath = {str(out / 'blender.png')!r}
    bpy.ops.wm.save_as_mainfile(filepath={str(out / 'fixture.blend')!r})
    bpy.ops.wm.open_mainfile(filepath={str(out / 'fixture.blend')!r})
    assert bpy.data.objects.get('Cube') is not None
    bpy.ops.render.render(write_still=True)
    '''))
    run('blender', ['blender', '--background', '--factory-startup', '--threads', '2', '--python', str(script)])
    assert (out / 'blender.png').read_bytes().startswith(b'\x89PNG')
    verify('blender', out / 'fixture.blend', [out / 'blender.png'])


def freecad():
    script = out / 'freecad-fixture.py'
    script.write_text(textwrap.dedent(f'''
    import FreeCAD, Part, Mesh
    from pathlib import Path
    doc = FreeCAD.newDocument('Fixture')
    box = doc.addObject('Part::Box', 'Box')
    box.Length = box.Width = box.Height = 10
    doc.recompute()
    doc.saveAs({str(out / 'fixture.FCStd')!r})
    FreeCAD.closeDocument(doc.Name)
    doc = FreeCAD.openDocument({str(out / 'fixture.FCStd')!r})
    assert abs(doc.getObject('Box').Shape.Volume - 1000) < 0.001
    Part.export([doc.getObject('Box')], {str(out / 'freecad.step')!r})
    Mesh.export([doc.getObject('Box')], {str(out / 'freecad.stl')!r})
    '''))
    run('freecad', ['freecadcmd', str(script)])
    assert zipfile.is_zipfile(out / 'fixture.FCStd')
    assert 'ISO-10303-21' in (out / 'freecad.step').read_text()
    verify('freecad', out / 'fixture.FCStd', [out / 'freecad.step', out / 'freecad.stl'])


def kdenlive():
    project = out / 'fixture.kdenlive'
    tree = ET.parse(Path(__file__).parents[1] / 'fixtures/workstation-empty.kdenlive')
    root = tree.getroot()
    root.set('root', str(out))
    profile = root.find('profile')
    profile.set('width', '320'); profile.set('height', '180')
    producer = ET.Element('producer', {'id': 'fixture-color', 'in': '0', 'out': '24'})
    for name, value in [('resource', '#3478f6'), ('mlt_service', 'color'), ('kdenlive:id', '4'), ('kdenlive:clipname', 'Fixture color')]:
        ET.SubElement(producer, 'property', {'name': name}).text = value
    root.insert(1, producer)
    ET.SubElement(root.find("playlist[@id='playlist4']"), 'entry', {'producer': 'fixture-color', 'in': '0', 'out': '24'})
    bin_ = root.find("playlist[@id='main_bin']")
    ET.SubElement(bin_, 'entry', {'producer': 'fixture-color', 'in': '0', 'out': '24'})
    for element in root.iter():
        if 'out' in element.attrib: element.set('out', '24')
        if element.tag == 'property' and element.get('name') == 'kdenlive:duration': element.text = '00:00:01:00'
        if element.tag == 'property' and element.get('name') == 'kdenlive:maxduration': element.text = '25'
    tree.write(project, encoding='utf-8', xml_declaration=True)
    # Kdenlive projects retain their bin producer; rendering uses the final project tractor.
    root.set('producer', 'tractor4')
    render_project = out / 'fixture-render.mlt'
    tree.write(render_project, encoding='utf-8', xml_declaration=True)
    run('kdenlive-render', ['melt', str(render_project), '-consumer', 'avformat:' + str(out / 'kdenlive.mp4'), 'vcodec=libx264', 'an=1', 'threads=2'])
    probe = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', str(out / 'kdenlive.mp4')], text=True)
    stream = json.loads(probe)['streams'][0]
    assert stream['width'] == 320 and stream['height'] == 180 and int(stream['nb_frames']) == 25, probe
    verify('kdenlive', project, [out / 'kdenlive.mp4'])

for application in args.only or ['inkscape', 'gimp', 'blender', 'freecad', 'kdenlive']:
    globals()[application]()
