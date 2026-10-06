"""Album summaries and compact, source-qualified label columns (no inference)."""

import base64
from collections import Counter

import numpy as np

from .store import fingerprint

HEAD_GROUPS = {'discogs400': 'style', 'moodtheme': 'mood', 'instrument': 'instruments',
               'approachability': 'approachability', 'engagement': 'engagement'}
PROBABILITIES = ('danceable', 'mood_acoustic', 'mood_aggressive', 'mood_electronic',
                 'mood_happy', 'mood_sad', 'mood_party', 'mood_relaxed',
                 'is_voice', 'is_instrumental', 'is_male', 'is_female',
                 *(f'mood_mirex_cluster_{i}' for i in range(1, 6)))
NUMBERS = (*PROBABILITIES, 'danceability')
CATEGORIES = ('voice_instrumental', 'gender', 'genre_rosamerica', 'mood_mirex')
ESSENTIA_FIELDS = (*NUMBERS, *CATEGORIES)


def quantize_vector(vector):
    """Cosine only needs direction: give each album the full signed-byte range."""
    vector = np.asarray(vector, dtype='f4')
    scale = np.max(np.abs(vector))
    if not scale or not np.isfinite(vector).all():
        raise ValueError('Invalid layout vector')
    values = np.clip(np.rint(vector / scale * 127), -127, 127).astype('i1')
    return base64.b64encode(values.tobytes()).decode('ascii')


def compact_sound(albums, labels):
    """Catalog pairs and positional fields avoid repeating labels/coverage keys."""
    indices = {column['id']: index for index, column in enumerate(labels)}
    for album in albums:
        for group in album['sound'].values():
            group['labels'] = [[indices[label['id']], label['score']] for label in group['labels']]
            group.pop('total', None)  # The denominator is always album.track_count.
        fields = []
        for key in ESSENTIA_FIELDS:
            field = album['essentia'][key]
            if field['value'] is None and not field['count']:
                fields.append(None)
            else:
                row = [field['value'], field['count']]
                if key in CATEGORIES and field['support'] is not None:
                    row.append(field['support'])
                fields.append(row)
        album['essentia'] = fields


def finite(value):
    try:
        number = float(value)
        return number if np.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def aggregate_essentia(items):
    result = {}
    for key in NUMBERS:
        values = [value for item in items if (value := finite(item.get(key))) is not None]
        # Out-of-domain probabilities are missing, not silently clipped.
        if key in PROBABILITIES:
            values = [value for value in values if 0 <= value <= 1]
        result[key] = {'value': round(sum(values) / len(values), 5) if values else None,
                       'count': len(values), 'total': len(items)}
    for key in CATEGORIES:
        values = [str(value).strip() for item in items
                  if (value := item.get(key)) is not None and str(value).strip()]
        counts = Counter(values).most_common()
        winner = counts[0] if counts and (len(counts) == 1 or counts[0][1] > counts[1][1]) else None
        result[key] = {'value': winner[0] if winner else None, 'count': len(values),
                       'total': len(items), 'support': round(winner[1] / len(values), 5) if winner else None}
    return result


def pool_heads(store, tracks, model):
    sums, counts, labels = {}, Counter(), {}
    for track in tracks:
        try:
            heads = store.heads(track['id'], fingerprint(track['path']), model)
        except (OSError, ValueError, TypeError):
            continue
        for name, head in heads.items():
            if name not in HEAD_GROUPS or not head['labels']:
                continue
            values = np.asarray(head['scores'], dtype='f8')
            if name in ('discogs400', 'moodtheme', 'instrument') and (
                    np.any(values < 0) or np.any(values > 1)):
                continue
            labels[name] = head['labels']
            sums.setdefault(name, np.zeros_like(values))[:] += values
            counts[name] += 1
    return {HEAD_GROUPS[name]: {'labels': labels[name], 'scores': values / counts[name],
                               'count': counts[name], 'total': len(tracks)}
            for name, values in sums.items()}


def zscores(scores):
    """Columnwise population calibration; only finite (eligible) rows contribute."""
    scores = np.asarray(scores, dtype='f8')
    result = np.full(scores.shape, np.nan)
    for column in range(scores.shape[1]):
        mask = np.isfinite(scores[:, column])
        values = scores[mask, column]
        if not len(values):
            continue
        std = values.std()
        result[mask, column] = (values - values.mean()) / std if std > 1e-8 else 0
    return result


def pack_scores(values, low=0, high=1):
    values = np.asarray(values, dtype='f8')
    packed = np.zeros(values.shape, dtype='u1')
    mask = np.isfinite(values)
    packed[mask] = 1 + np.rint((np.clip(values[mask], low, high) - low) * 254 / (high - low)).astype('u1')
    return base64.b64encode(packed.tobytes()).decode('ascii')


class LabelColumns:
    def __init__(self, count):
        self.count = count
        self.columns = {}

    def put(self, index, source, name, value, kind='probability', axis=None):
        identity = f'{source}:{name}'
        if identity not in self.columns:
            self.columns[identity] = {'id': identity, 'source': source, 'label': name,
                                      'kind': kind, 'axis': axis,
                                      'values': np.full(self.count, np.nan)}
        self.columns[identity]['values'][index] = value
        return identity

    def export(self):
        result = []
        for identity in sorted(self.columns):
            column = self.columns[identity].copy()
            values = column.pop('values')
            if column['kind'] == 'relative':
                values = zscores(values[:, None])[:, 0]
            low, high = (-4, 4) if column['kind'] in ('zscore', 'relative') else (0, 1)
            column.update(min=low, max=high, scores=pack_scores(values, low, high))
            result.append(column)
        return result


def add_main_labels(albums, heads, columns):
    for index, (album, groups) in enumerate(zip(albums, heads)):
        album['sound'] = {}
        for source, head in groups.items():
            scalar = source in ('approachability', 'engagement')
            labels = []
            for name, score in zip(head['labels'], head['scores']):
                identity = columns.put(index, source, name, score, 'relative' if scalar else 'probability')
                labels.append({'id': identity, 'label': name, 'score': round(float(score), 5)})
            labels.sort(key=lambda label: (-label['score'], label['label']))
            album['sound'][source] = {'labels': labels[:5], 'count': head['count'], 'total': head['total']}
        for key, field in album['essentia'].items():
            value = field['value']
            if value is None:
                continue
            if key in CATEGORIES:
                columns.put(index, 'essentia', f'{key}={value}', field['support'], 'category')
            else:
                columns.put(index, 'essentia', key, value,
                            'probability' if key in PROBABILITIES else 'relative')
