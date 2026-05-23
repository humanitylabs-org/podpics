#!/usr/bin/env python3
import argparse
import copy
import datetime as dt
import json
import os
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote


def to_relative_file_url(basename: str) -> str:
    # Proper relative file URL — Resolve resolves it against the .otio folder
    # on first pass, so no "clip not found" dialog. Percent-encodes spaces and
    # other special chars per RFC 3986.
    return 'file:./' + quote(basename, safe='')

SCRIPT_ROOT = Path(__file__).resolve().parent
AGENT_WORKSPACE = SCRIPT_ROOT.parent.parent
BASE = Path(os.getenv('PODPICS_STORAGE_ROOT', str(AGENT_WORKSPACE / 'podpics-workspace')))


def resolve_paths(base_root: Path):
    root = Path(base_root)

    new_layout = {
        'base': root,
        'template_fcpxml': root / 'Timelines' / 'Episode 4.fcpxml',
        'template_otio': root / 'Timelines' / 'Episode 4.otio',
        'default_raw_video': root / 'inbox' / 'Episode 4 Raw Video.mp4',
        'default_image': root / 'assets' / '02_reference' / 'Antifragile Book.jpg',
        'output_root': root / 'outputs' / 'timelines-tests',
    }

    old_layout = {
        'base': root,
        'template_fcpxml': root / 'Timelines' / 'Episode 4.fcpxml',
        'template_otio': root / 'Timelines' / 'Episode 4.otio',
        'default_raw_video': root / 'Timelines' / 'Episode 4 Raw Video.mp4',
        'default_image': root / '01_asset-library' / '01_approved-images-e01-e04' / '02_reference' / 'Antifragile Book.jpg',
        'output_root': root / '02_episode-work' / '01_E05' / '06_timeline' / 'tests',
    }

    if (root / 'inbox').exists() or (root / 'projects').exists() or (root / 'outputs').exists():
        return new_layout

    return old_layout

VIDEO_EXTS = {'.mp4', '.mov', '.mxf', '.m4v'}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.avif'}


def as_file_uri(p: Path) -> str:
    return p.resolve().as_uri()


def choose_existing(*paths: Path) -> Path:
    for p in paths:
        if p.exists():
            return p
    raise FileNotFoundError(f'None of the candidate paths exist: {paths}')


def find_first_file(root: Path, allowed_exts, max_depth: int = 4):
    if not root.exists():
        return None

    stack = [(root, 0)]
    while stack:
        cur, depth = stack.pop(0)
        if depth > max_depth:
            continue
        try:
            entries = sorted(cur.iterdir(), key=lambda p: p.name.lower())
        except Exception:
            continue

        for p in entries:
            if p.is_dir():
                stack.append((p, depth + 1))
            elif p.is_file() and p.suffix.lower() in allowed_exts:
                return p
    return None


def find_first_image_asset(root: ET.Element, raw_video_name: str):
    for asset in root.findall('.//asset'):
        name = asset.attrib.get('name', '')
        if name and name != raw_video_name and Path(name).suffix.lower() in IMAGE_EXTS:
            return asset
    for asset in root.findall('.//asset'):
        name = asset.attrib.get('name', '')
        if name and name != raw_video_name:
            return asset
    return None


def patch_fcpxml(template_path: Path, out_path: Path, raw_video: Path, overlay_image: Path):
    tree = ET.parse(template_path)
    root = tree.getroot()

    raw_name = raw_video.name
    raw_uri = as_file_uri(raw_video)

    # Point all primary video assets to chosen raw video (helps predictable relink).
    for asset in root.findall('.//asset'):
        if asset.attrib.get('name') == raw_name or asset.attrib.get('hasAudio') == '1':
            media_rep = asset.find('media-rep')
            if media_rep is not None:
                media_rep.set('src', raw_uri)
                asset.set('name', raw_name)

    first_overlay = find_first_image_asset(root, raw_name)
    if first_overlay is None:
        raise RuntimeError('Could not find an overlay image asset in FCPXML template')

    first_overlay.set('name', overlay_image.name)
    media_rep = first_overlay.find('media-rep')
    if media_rep is None:
        media_rep = ET.SubElement(first_overlay, 'media-rep')
    media_rep.set('kind', media_rep.attrib.get('kind', 'original-media'))
    media_rep.set('src', as_file_uri(overlay_image))

    tree.write(out_path, encoding='utf-8', xml_declaration=True)


def iter_otio_clips(otio_obj):
    tracks = otio_obj.get('tracks', {}).get('children', [])
    for t in tracks:
        for ch in t.get('children', []):
            if isinstance(ch, dict) and str(ch.get('OTIO_SCHEMA', '')).startswith('Clip'):
                yield ch


def get_target_url(clip: dict):
    refs = clip.get('media_references')
    if isinstance(refs, dict) and isinstance(refs.get('DEFAULT_MEDIA'), dict):
        return refs['DEFAULT_MEDIA'].get('target_url')
    ref = clip.get('media_reference')
    if isinstance(ref, dict):
        return ref.get('target_url')
    return None


def set_target_url(clip: dict, url: str):
    refs = clip.get('media_references')
    if isinstance(refs, dict) and isinstance(refs.get('DEFAULT_MEDIA'), dict):
        refs['DEFAULT_MEDIA']['target_url'] = url
        return
    ref = clip.get('media_reference')
    if isinstance(ref, dict):
        ref['target_url'] = url


def patch_clip_media_name_and_url(clip: dict, name: str, url: str):
    clip['name'] = name
    refs = clip.get('media_references')
    if isinstance(refs, dict) and isinstance(refs.get('DEFAULT_MEDIA'), dict):
        refs['DEFAULT_MEDIA']['name'] = name
        refs['DEFAULT_MEDIA']['target_url'] = url
        return
    ref = clip.get('media_reference')
    if isinstance(ref, dict):
        ref['name'] = name
        ref['target_url'] = url


def make_gap(frames: float, rate: float = 24.0):
    return {
        'OTIO_SCHEMA': 'Gap.1',
        'metadata': {},
        'name': '',
        'source_range': {
            'OTIO_SCHEMA': 'TimeRange.1',
            'duration': {'OTIO_SCHEMA': 'RationalTime.1', 'rate': rate, 'value': float(max(frames, 0.0))},
            'start_time': {'OTIO_SCHEMA': 'RationalTime.1', 'rate': rate, 'value': 0.0},
        },
        'effects': [],
        'markers': [],
        'enabled': True,
    }


def find_first_image_clip(otio_obj):
    for clip in iter_otio_clips(otio_obj):
        url = (get_target_url(clip) or '').lower()
        name = (clip.get('name') or '').lower()
        ext = Path(url).suffix.lower() or Path(name).suffix.lower()
        if ext in IMAGE_EXTS or any(k in name for k in ['.png', '.jpg', '.jpeg', '.webp', '.avif']):
            return clip
    return None


def find_transform_effect_template(otio_obj):
    fallback = None
    for clip in iter_otio_clips(otio_obj):
        for eff in clip.get('effects', []):
            md = ((eff.get('metadata') or {}).get('Resolve_OTIO') or {})
            if md.get('Effect Name') == 'Transform':
                params = md.get('Parameters') or []
                if any((p or {}).get('Parameter ID') == 'transformationZoomX' for p in params):
                    return copy.deepcopy(eff)
                if fallback is None:
                    fallback = copy.deepcopy(eff)
    return fallback


def patch_otio_clean(template_path: Path, out_path: Path, raw_video: Path, overlay_image: Path,
                     overlay_offset_frames: int = 1440, overlay_duration_frames: int = 120,
                     overlay_zoom: float = 0.33, overlay_pan: float = 0.72, overlay_tilt: float = 0.0):
    obj = json.loads(template_path.read_text(encoding='utf-8'))
    tracks = obj.get('tracks', {}).get('children', [])
    if len(tracks) < 2:
        raise RuntimeError('Unexpected OTIO template shape: missing tracks')

    # Keep one main video track + one overlay track + one audio track.
    main_video_track = copy.deepcopy(tracks[0])
    overlay_track = copy.deepcopy(tracks[1])
    audio_track = copy.deepcopy(next((t for t in tracks if t.get('kind') == 'Audio'), tracks[-1]))

    raw_url = str(raw_video.resolve())
    for clip in main_video_track.get('children', []):
        if str(clip.get('OTIO_SCHEMA', '')).startswith('Clip'):
            patch_clip_media_name_and_url(clip, raw_video.name, raw_url)
    for clip in audio_track.get('children', []):
        if str(clip.get('OTIO_SCHEMA', '')).startswith('Clip'):
            patch_clip_media_name_and_url(clip, raw_video.name, raw_url)

    total_frames = 0.0
    for ch in overlay_track.get('children', []):
        sr = ch.get('source_range') or {}
        dur = (sr.get('duration') or {}).get('value')
        if dur is not None:
            total_frames += float(dur)
    if total_frames <= 0:
        # Fallback: sum from main video track.
        for ch in main_video_track.get('children', []):
            sr = ch.get('source_range') or {}
            dur = (sr.get('duration') or {}).get('value')
            if dur is not None:
                total_frames += float(dur)

    image_clip_template = find_first_image_clip(obj)
    if image_clip_template is None:
        raise RuntimeError('Could not find an image clip template in OTIO')

    transform_template = find_transform_effect_template(obj)

    image_clip = copy.deepcopy(image_clip_template)
    # Overlay PNG lives in the same folder as the .otio (bundled by the caller),
    # so target_url is a relative file: URL — keeps the folder portable and
    # avoids Resolve's "clip not found" first-pass dialog.
    patch_clip_media_name_and_url(image_clip, overlay_image.name, to_relative_file_url(overlay_image.name))

    if not isinstance(image_clip.get('effects'), list):
        image_clip['effects'] = []

    if not any((((e.get('metadata') or {}).get('Resolve_OTIO') or {}).get('Effect Name') == 'Transform') for e in image_clip['effects']):
        if transform_template is not None:
            image_clip['effects'].append(copy.deepcopy(transform_template))
        else:
            image_clip['effects'].append({
                'OTIO_SCHEMA': 'Effect.1',
                'metadata': {
                    'Resolve_OTIO': {
                        'Display Type': 1,
                        'Effect Name': 'Transform',
                        'Enabled': True,
                        'Name': 'Transform',
                        'Parameters': [
                            {'Parameter ID': 'transformationZoomX', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                            {'Parameter ID': 'transformationZoomY', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                            {'Parameter ID': 'transformationPan', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                            {'Parameter ID': 'transformationTilt', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                        ],
                        'Type': 2,
                    }
                },
                'name': '',
                'effect_name': 'Resolve Effect',
            })

    # Force smaller picture-in-picture style overlay (not full-screen).
    for eff in image_clip.get('effects', []):
        md = ((eff.get('metadata') or {}).get('Resolve_OTIO') or {})
        if md.get('Effect Name') != 'Transform':
            continue
        params = md.get('Parameters')
        if not isinstance(params, list) or len(params) == 0:
            md['Parameters'] = [
                {'Parameter ID': 'transformationZoomX', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                {'Parameter ID': 'transformationZoomY', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                {'Parameter ID': 'transformationPan', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                {'Parameter ID': 'transformationTilt', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
            ]
            params = md['Parameters']
        for prm in params:
            pid = prm.get('Parameter ID')
            if pid == 'transformationZoomX':
                prm['Parameter Value'] = float(overlay_zoom)
            elif pid == 'transformationZoomY':
                prm['Parameter Value'] = float(overlay_zoom)
            elif pid == 'transformationPan':
                prm['Parameter Value'] = float(overlay_pan)
            elif pid == 'transformationTilt':
                prm['Parameter Value'] = float(overlay_tilt)
    if image_clip.get('source_range') and image_clip['source_range'].get('duration'):
        image_clip['source_range']['duration']['value'] = float(overlay_duration_frames)
    if image_clip.get('source_range') and image_clip['source_range'].get('start_time'):
        image_clip['source_range']['start_time']['value'] = 0.0

    pre = float(max(0, overlay_offset_frames))
    dur = float(max(1, overlay_duration_frames))
    if pre + dur > total_frames:
        pre = max(0.0, total_frames - dur)
    post = max(0.0, total_frames - pre - dur)

    overlay_track['children'] = [make_gap(pre), image_clip, make_gap(post)]

    # Ensure a deterministic stack for clean import.
    obj['tracks']['children'] = [main_video_track, overlay_track, audio_track]

    out_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')

    fps = 24
    timeline_start = int((obj.get('global_start_time') or {}).get('value', 86400.0))
    start_frames = timeline_start + int(pre)
    h = start_frames // (3600 * fps)
    rem = start_frames % (3600 * fps)
    m = rem // (60 * fps)
    rem = rem % (60 * fps)
    s = rem // fps
    f = rem % fps
    tc = f'{h:02d}:{m:02d}:{s:02d}:{f:02d}'

    return {
        'overlayStartTc': tc,
        'overlayDurationFrames': int(dur),
        'overlayDurationSeconds': round(dur / fps, 3),
    }


def build_overlay_clip(template_path_obj: dict, overlay_image: Path,
                       duration_frames: int, zoom: float, pan: float, tilt: float):
    image_clip_template = find_first_image_clip(template_path_obj)
    if image_clip_template is None:
        raise RuntimeError('Could not find an image clip template in OTIO')
    transform_template = find_transform_effect_template(template_path_obj)

    image_clip = copy.deepcopy(image_clip_template)
    # Overlay PNG lives in the same folder as the .otio (bundled by the caller),
    # so target_url is a relative file: URL — keeps the folder portable and
    # avoids Resolve's "clip not found" first-pass dialog.
    patch_clip_media_name_and_url(image_clip, overlay_image.name, to_relative_file_url(overlay_image.name))

    if not isinstance(image_clip.get('effects'), list):
        image_clip['effects'] = []

    has_transform = any(
        (((e.get('metadata') or {}).get('Resolve_OTIO') or {}).get('Effect Name') == 'Transform')
        for e in image_clip['effects']
    )
    if not has_transform:
        if transform_template is not None:
            image_clip['effects'].append(copy.deepcopy(transform_template))
        else:
            image_clip['effects'].append({
                'OTIO_SCHEMA': 'Effect.1',
                'metadata': {
                    'Resolve_OTIO': {
                        'Display Type': 1,
                        'Effect Name': 'Transform',
                        'Enabled': True,
                        'Name': 'Transform',
                        'Parameters': [
                            {'Parameter ID': 'transformationZoomX', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                            {'Parameter ID': 'transformationZoomY', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                            {'Parameter ID': 'transformationPan', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                            {'Parameter ID': 'transformationTilt', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                        ],
                        'Type': 2,
                    }
                },
                'name': '',
                'effect_name': 'Resolve Effect',
            })

    for eff in image_clip.get('effects', []):
        md = ((eff.get('metadata') or {}).get('Resolve_OTIO') or {})
        if md.get('Effect Name') != 'Transform':
            continue
        params = md.get('Parameters')
        if not isinstance(params, list) or len(params) == 0:
            md['Parameters'] = [
                {'Parameter ID': 'transformationZoomX', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                {'Parameter ID': 'transformationZoomY', 'Parameter Value': 1.0, 'Variant Type': 'Double', 'Default Parameter Value': 1.0},
                {'Parameter ID': 'transformationPan', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
                {'Parameter ID': 'transformationTilt', 'Parameter Value': 0.0, 'Variant Type': 'Double', 'Default Parameter Value': 0.0},
            ]
            params = md['Parameters']
        for prm in params:
            pid = prm.get('Parameter ID')
            if pid == 'transformationZoomX':
                prm['Parameter Value'] = float(zoom)
            elif pid == 'transformationZoomY':
                prm['Parameter Value'] = float(zoom)
            elif pid == 'transformationPan':
                prm['Parameter Value'] = float(pan)
            elif pid == 'transformationTilt':
                prm['Parameter Value'] = float(tilt)

    if image_clip.get('source_range') and image_clip['source_range'].get('duration'):
        image_clip['source_range']['duration']['value'] = float(duration_frames)
    if image_clip.get('source_range') and image_clip['source_range'].get('start_time'):
        image_clip['source_range']['start_time']['value'] = 0.0

    return image_clip


def patch_otio_clean_multi(template_path: Path, out_path: Path, raw_video: Path, overlays: list, fps: float = 24.0):
    obj = json.loads(template_path.read_text(encoding='utf-8'))
    tracks = obj.get('tracks', {}).get('children', [])
    if len(tracks) < 2:
        raise RuntimeError('Unexpected OTIO template shape: missing tracks')

    main_video_track = copy.deepcopy(tracks[0])
    overlay_track = copy.deepcopy(tracks[1])
    audio_track = copy.deepcopy(next((t for t in tracks if t.get('kind') == 'Audio'), tracks[-1]))

    # Self-contained folder: .otio + raw video + overlay PNGs all live next to
    # each other, so target_url is a relative file: URL. Keeps the folder
    # portable across Linux/Mac and lets Resolve resolve on the first pass
    # (no "clip not found" dialog).
    raw_url = to_relative_file_url(raw_video.name)
    for clip in main_video_track.get('children', []):
        if str(clip.get('OTIO_SCHEMA', '')).startswith('Clip'):
            patch_clip_media_name_and_url(clip, raw_video.name, raw_url)
    for clip in audio_track.get('children', []):
        if str(clip.get('OTIO_SCHEMA', '')).startswith('Clip'):
            patch_clip_media_name_and_url(clip, raw_video.name, raw_url)

    total_frames = 0.0
    for ch in main_video_track.get('children', []):
        sr = ch.get('source_range') or {}
        dur = (sr.get('duration') or {}).get('value')
        if dur is not None:
            total_frames += float(dur)
    if total_frames <= 0:
        for ch in overlay_track.get('children', []):
            sr = ch.get('source_range') or {}
            dur = (sr.get('duration') or {}).get('value')
            if dur is not None:
                total_frames += float(dur)

    items = []
    for ov in overlays:
        img = Path(str(ov['image'])).resolve()
        offset_frames = int(round(float(ov.get('offsetSeconds', 0.0)) * fps))
        duration_frames = max(1, int(round(float(ov.get('durationSeconds', 5.0)) * fps)))
        items.append({
            'image': img,
            'offset_frames': max(0, offset_frames),
            'duration_frames': duration_frames,
            'zoom': float(ov.get('zoom', 0.33)),
            'pan': float(ov.get('pan', 0.0)),
            'tilt': float(ov.get('tilt', 0.0)),
        })

    items.sort(key=lambda x: x['offset_frames'])

    placed = []
    cursor = 0.0
    children = []
    for it in items:
        start = float(it['offset_frames'])
        dur = float(it['duration_frames'])
        if start < cursor:
            start = cursor
        if start + dur > total_frames and total_frames > 0:
            start = max(0.0, total_frames - dur)
        gap_frames = max(0.0, start - cursor)
        if gap_frames > 0:
            children.append(make_gap(gap_frames, fps))
        clip = build_overlay_clip(obj, it['image'], int(dur), it['zoom'], it['pan'], it['tilt'])
        children.append(clip)
        cursor = start + dur
        placed.append({
            'image': str(it['image']),
            'offsetFrames': int(start),
            'durationFrames': int(dur),
            'zoom': it['zoom'],
            'pan': it['pan'],
            'tilt': it['tilt'],
        })

    if total_frames > cursor:
        children.append(make_gap(total_frames - cursor, fps))

    overlay_track['children'] = children
    obj['tracks']['children'] = [main_video_track, overlay_track, audio_track]
    out_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')

    return {
        'overlayCount': len(placed),
        'overlays': placed,
        'totalFrames': int(total_frames),
        'fps': fps,
    }


def patch_otio(template_path: Path, out_path: Path, raw_video: Path, overlay_image: Path):
    obj = json.loads(template_path.read_text(encoding='utf-8'))

    raw_name = raw_video.name.lower()
    first_overlay_done = False

    for clip in iter_otio_clips(obj):
        url = get_target_url(clip) or ''
        name = (clip.get('name') or '').lower()
        ext = Path(url).suffix.lower() or Path(name).suffix.lower()
        base = Path(url).name.lower() if url else name

        if base == raw_name or ext in VIDEO_EXTS:
            set_target_url(clip, str(raw_video.resolve()))
            clip['name'] = raw_video.name
            continue

        if (ext in IMAGE_EXTS or any(k in base for k in ['.png', '.jpg', '.jpeg', '.webp', '.avif'])) and not first_overlay_done:
            set_target_url(clip, str(overlay_image.resolve()))
            clip['name'] = overlay_image.name
            first_overlay_done = True

    if not first_overlay_done:
        raise RuntimeError('Could not find an image clip to patch in OTIO template')

    out_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description='Generate a podpics test OTIO/FCPXML timeline with one patched overlay image.')
    ap.add_argument('--storage-root', default=str(BASE), help='Root folder for podpics workspace data')
    ap.add_argument('--raw-video', default=None, help='Path to raw video file')
    ap.add_argument('--overlay-image', default=None, help='Path to overlay image file')
    ap.add_argument('--label', default='test-import', help='Label prefix for output folder')
    ap.add_argument('--offset-seconds', type=float, default=60.0, help='Overlay start offset in seconds from timeline start')
    ap.add_argument('--duration-seconds', type=float, default=5.0, help='Overlay duration in seconds')
    ap.add_argument('--overlay-zoom', type=float, default=0.33, help='Overlay scale (Transform zoom X/Y)')
    ap.add_argument('--overlay-pan', type=float, default=0.72, help='Overlay horizontal position (Transform pan)')
    ap.add_argument('--overlay-tilt', type=float, default=0.0, help='Overlay vertical position (Transform tilt)')
    ap.add_argument('--overlays-json', default=None, help='Path to JSON file with list of overlays for multi-section export')
    args = ap.parse_args()

    paths = resolve_paths(Path(args.storage_root))
    template_fcpxml = paths['template_fcpxml']
    template_otio = paths['template_otio']
    default_raw_video = paths['default_raw_video']
    default_image = paths['default_image']
    output_root = paths['output_root']

    raw_candidate = Path(args.raw_video) if args.raw_video else default_raw_video
    if not raw_candidate.exists():
        raw_candidate = find_first_file(paths['base'] / 'inbox', VIDEO_EXTS) or find_first_file(paths['base'] / 'Timelines', VIDEO_EXTS) or raw_candidate

    raw_video = choose_existing(raw_candidate, default_raw_video)

    if not template_otio.exists():
        raise FileNotFoundError('Missing Episode 4 OTIO template in /Timelines')

    output_root.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    out_dir = output_root / f'{args.label}-{ts}'
    out_dir.mkdir(parents=True, exist_ok=True)

    overlay_src = None
    if not args.overlays_json:
        overlay_candidate = Path(args.overlay_image) if args.overlay_image else default_image
        if not overlay_candidate.exists():
            overlay_candidate = (
                find_first_file(paths['base'] / 'assets', IMAGE_EXTS)
                or find_first_file(paths['base'] / 'inbox', IMAGE_EXTS)
                or find_first_file(paths['base'] / '01_asset-library', IMAGE_EXTS)
                or overlay_candidate
            )
        overlay_src = choose_existing(overlay_candidate, default_image)
        if not template_fcpxml.exists():
            raise FileNotFoundError('Missing Episode 4 FCPXML template in /Timelines')

    if args.overlays_json:
        overlays_payload = json.loads(Path(args.overlays_json).read_text(encoding='utf-8'))
        items_raw = overlays_payload if isinstance(overlays_payload, list) else overlays_payload.get('overlays', [])
        if not items_raw:
            raise RuntimeError('--overlays-json provided but contains no overlays')

        copied_overlays = []
        for ov in items_raw:
            src_path = Path(str(ov.get('image') or '')).expanduser()
            if not src_path.exists():
                raise FileNotFoundError(f'Overlay image not found: {src_path}')
            dest = out_dir / src_path.name
            n = 1
            while dest.exists() and dest.resolve() != src_path.resolve():
                dest = out_dir / f'{src_path.stem}-{n}{src_path.suffix}'
                n += 1
            if dest.resolve() != src_path.resolve():
                shutil.copy2(src_path, dest)
            copied_overlays.append({
                'image': str(dest),
                'offsetSeconds': float(ov.get('offsetSeconds', 0.0)),
                'durationSeconds': float(ov.get('durationSeconds', 5.0)),
                'zoom': float(ov.get('zoom', 0.28)),
                'pan': float(ov.get('pan', 0.0)),
                'tilt': float(ov.get('tilt', 0.0)),
            })

        # Copy/hardlink the raw video into the export dir so the folder is
        # self-contained — Resolve can relink everything from one place.
        raw_video_copy = out_dir / raw_video.name
        if not raw_video_copy.exists():
            try:
                os.link(str(raw_video), str(raw_video_copy))  # hardlink on same FS
            except OSError:
                shutil.copy2(str(raw_video), str(raw_video_copy))

        out_otio_full = out_dir / 'podpics-timeline.otio'
        full_meta = patch_otio_clean_multi(template_otio, out_otio_full, raw_video_copy, copied_overlays)

        manifest = {
            'createdAtUtc': dt.datetime.utcnow().isoformat(timespec='seconds') + 'Z',
            'mode': 'multi-section',
            'storageRoot': str(paths['base']),
            'rawVideo': str(raw_video_copy),
            'rawVideoSource': str(raw_video),
            'overlayCount': full_meta['overlayCount'],
            'templateOtio': str(template_otio),
            'outputDir': str(out_dir),
            'outputs': {
                'otio': str(out_otio_full),
                'rawVideo': str(raw_video_copy),
            },
            'recommendedForResolveTest': str(out_otio_full),
            'overlaysPlaced': full_meta['overlays'],
            'notes': [
                'Self-contained DaVinci Resolve project folder.',
                'Raw video, overlay PNGs, and OTIO are all bundled here with relative paths — move the whole folder anywhere and import podpics-timeline.otio in Resolve.',
            ],
        }
        (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(manifest, ensure_ascii=False))
        return

    overlay_copy = out_dir / overlay_src.name
    shutil.copy2(overlay_src, overlay_copy)

    out_fcpxml = out_dir / 'podpics-test.fcpxml'
    out_otio = out_dir / 'podpics-test.otio'
    out_otio_clean = out_dir / 'podpics-test-clean.otio'

    patch_fcpxml(template_fcpxml, out_fcpxml, raw_video, overlay_copy)
    patch_otio(template_otio, out_otio, raw_video, overlay_copy)

    # Assume 24 fps template timeline (Episode 4 exports are 24fps).
    offset_frames = int(round(float(args.offset_seconds) * 24.0))
    duration_frames = int(round(float(args.duration_seconds) * 24.0))
    clean_meta = patch_otio_clean(
        template_otio,
        out_otio_clean,
        raw_video,
        overlay_copy,
        overlay_offset_frames=offset_frames,
        overlay_duration_frames=duration_frames,
        overlay_zoom=float(args.overlay_zoom),
        overlay_pan=float(args.overlay_pan),
        overlay_tilt=float(args.overlay_tilt),
    )

    manifest = {
        'createdAtUtc': dt.datetime.utcnow().isoformat(timespec='seconds') + 'Z',
        'mode': 'single-section',
        'storageRoot': str(paths['base']),
        'rawVideo': str(raw_video),
        'overlayImage': str(overlay_copy),
        'templateFcpxml': str(template_fcpxml),
        'templateOtio': str(template_otio),
        'outputDir': str(out_dir),
        'outputs': {
            'fcpxml': str(out_fcpxml),
            'otio': str(out_otio),
            'otioClean': str(out_otio_clean),
        },
        'recommendedForResolveTest': str(out_otio_clean),
        'overlayPlacement': clean_meta,
        'overlayTransform': {
            'zoom': float(args.overlay_zoom),
            'pan': float(args.overlay_pan),
            'tilt': float(args.overlay_tilt),
        },
        'notes': [
            'For the clean test, import podpics-test-clean.otio in DaVinci Resolve.',
            'podpics-test.otio and podpics-test.fcpxml are template-patch debug variants.',
            'If media is offline, relink to local copies of video/image assets under your selected storage root.'
        ]
    }
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    main()
