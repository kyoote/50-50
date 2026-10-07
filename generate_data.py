import argparse
import calendar
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import zipfile
import shutil

parser = argparse.ArgumentParser(description='50:50 real-grid aggregation; no synthetic data.')
parser.add_argument('--raw', type=Path, required=True)
parser.add_argument('--deps', type=Path)
parser.add_argument('--stage', choices=['maps', 'rain', 'cover', 'land', 'ocean', 'seasons', 'built', 'population', 'bundle', 'all'], default='all')
parser.add_argument('--workers', type=int, default=4)
parser.add_argument('--region', choices=['world', 'japan', 'all'], default='all')
args = parser.parse_args()
if args.deps:
    sys.path.insert(0, str(args.deps.resolve()))
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import Window, from_bounds
import shapely
from shapely.geometry import shape, mapping, box
from scipy.io import netcdf_file

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'data'
OUT.mkdir(exist_ok=True)
RAW = args.raw.resolve()
WORKERS = max(1, min(args.workers, max(1, (os.cpu_count() or 2) - 1), 4))
RADIUS = 6371007.1809
COVER = {'forest': (10, '樹木被覆面積'), 'cropland': (40, '農地面積'), 'builtup': (50, '市街地面積'), 'grassland': (30, '草地面積'), 'water': (80, '湖・河川などの水面積'), 'shrubland': (20, '低木地面積'), 'wetland': (90, '湿地面積'), 'bare': (60, '裸地・岩場などの面積')}
JAPAN = shapely.union_all([shape(f['geometry']) for f in json.loads((RAW / 'japan.geojson').read_text())['features']])
print(f'Logical CPUs: {os.cpu_count()}, processing workers: {WORKERS}; internal BLAS threads: 1', flush=True)

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')

def file_hash(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def cell_area(south, north, width):
    return RADIUS ** 2 * np.deg2rad(width) * (np.sin(np.deg2rad(north)) - np.sin(np.deg2rad(south)))

def polygon_area(geom):
    def project(coords):
        return np.column_stack((np.deg2rad(coords[:, 0]) * RADIUS, np.sin(np.deg2rad(coords[:, 1])) * RADIUS))
    return shapely.area(shapely.transform(geom, project))

def axis_data(edges, weights):
    edges, weights = np.asarray(edges, dtype=np.float64), np.asarray(weights, dtype=np.float64)
    assert np.all(np.isfinite(weights)) and np.all(weights >= 0)
    assert len(edges) == len(weights) + 1 and np.all(np.diff(edges) > 0)
    cumulative = np.r_[0., np.cumsum(weights)]
    assert cumulative[-1] > 0
    middle = int(np.searchsorted(cumulative, cumulative[-1] / 2, side='right') - 1)
    fraction = (cumulative[-1] / 2 - cumulative[middle]) / weights[middle]
    median = edges[middle] + fraction * (edges[middle + 1] - edges[middle])
    return {'edges': edges.tolist(), 'distribution': weights.tolist(), 'cumulative': cumulative.tolist(), 'median': float(median)}

def save_metric(key, region, lon_edges, lon_weights, lat_edges, lat_weights, metadata, validation):
    longitude, latitude = axis_data(lon_edges, lon_weights), axis_data(lat_edges, lat_weights)
    total = longitude['cumulative'][-1]
    assert math.isclose(total, latitude['cumulative'][-1], rel_tol=2e-10)
    result = {'id': f'{key}_{region}', 'metric': key, 'region': region, 'total': total,
              'longitude': longitude, 'latitude': latitude, 'metadata': metadata,
              'validation': dict(validation, axis_relative_difference=abs(total - latitude['cumulative'][-1]) / total)}
    write_json(OUT / f'{key}_{region}.json', result)
    print(result['id'], 'total', round(total, 3), 'medians', longitude['median'], latitude['median'], flush=True)

def make_maps():
    world = json.loads((RAW / 'world.geojson').read_text(encoding='utf-8'))
    features = []
    for feature in world['features']:
        props = feature['properties']
        geometry = shape(feature['geometry']).simplify(.018, preserve_topology=True)
        features.append({'type': 'Feature', 'properties': {'name': props.get('NAME_EN', props.get('NAME')), 'iso': props.get('ADM0_A3')}, 'geometry': mapping(geometry)})
    write_json(OUT / 'world.geojson', {'type': 'FeatureCollection', 'features': features})
    write_json(OUT / 'japan.geojson', {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'name': 'Japan'}, 'geometry': mapping(JAPAN.simplify(.0015, preserve_topology=True))}]})
    write_json(OUT / 'japan_boundary_metadata.json', json.loads((RAW / 'japan_metadata.json').read_text()))

def make_population(region):
    path = RAW / f'population_{region}.tif'
    with rasterio.open(path) as source:
        width, height, transform = source.width, source.height, source.transform
        assert source.crs.to_epsg() == 4326 and transform.a > 0 and transform.e < 0
        print('Population raster', region, width, height, flush=True)
    chunks = [(row, min(256, height - row)) for row in range(0, height, 256)]
    cuts = [0, 90, 135, 140] if region == 'world' else [130, 135, 140, 145]
    cols = [max(0, min(width, int(round((x - transform.c) / transform.a)))) for x in cuts]
    def aggregate(chunk):
        row, count = chunk
        with rasterio.open(path) as source:
            values = source.read(1, window=Window(0, row, width, count))
        values[~np.isfinite(values) | (values < 0)] = 0
        return row, values.sum(0, dtype=np.float64), values.sum(1, dtype=np.float64), float(values.sum(dtype=np.float64)), [float(values[:, :col].sum(dtype=np.float64)) for col in cols]
    longitude, latitude = np.zeros(width), np.zeros(height)
    total, direct = 0., np.zeros(len(cols))
    with rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024):
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            for index, (row, lon, lat, subtotal, checks) in enumerate(pool.map(aggregate, chunks)):
                longitude += lon
                latitude[row:row + len(lat)] = lat
                total += subtotal
                direct += checks
                if index % 20 == 0:
                    print(region, 'rows', row, '/', height, flush=True)
    assert np.isclose(total, longitude.sum(), rtol=1e-12)
    if region == 'world':
        assert 7e9 < total < 9e9
    else:
        assert 1.1e8 < total < 1.35e8
    cumulative = np.r_[0., np.cumsum(longitude)]
    checks = [{'longitude': float(transform.c + col * transform.a), 'raw_west_total': float(value), 'cdf_west_total': float(cumulative[col])} for col, value in zip(cols, direct)]
    assert all(math.isclose(c['raw_west_total'], c['cdf_west_total'], rel_tol=2e-10, abs_tol=1e-5) for c in checks)
    metadata = {'name': '人口', 'dataset': 'WorldPop Global2 R2025A v1, constrained', 'year': 2025,
                'resolution': '30 arc-seconds (~1 km)' if region == 'world' else '3 arc-seconds (~100 m)',
                'provider': 'WorldPop, University of Southampton', 'license': 'CC BY 4.0', 'unit': '人',
                'url': 'https://hub.worldpop.org/project/categories?id=3', 'sha256': file_hash(path),
                'method': '全有効セルの人口を元解像度で行・列合計。NoData・負値を除外。日本は提供元の日本専用グリッド。',
                'note': '2025年の推計人口。実測の個人位置ではありません。セル内は一様として補間。'}
    save_metric('population', region, transform.c + np.arange(width + 1) * transform.a, longitude,
                (transform.f + np.arange(height + 1) * transform.e)[::-1], latitude[::-1], metadata,
                {'source_grid_total': total, 'cuts': checks, 'valid_total_range': True, 'source_width': width, 'source_height': height})

def make_rain():
    with netcdf_file(RAW / 'rainfall_2025.nc', mmap=False) as source:
        dates = [dt.datetime(1800, 1, 1) + dt.timedelta(days=float(day)) for day in source.variables['time'][:]]
        indices = [i for i, date in enumerate(dates) if date.year == 2025]
        assert [dates[i].month for i in indices] == list(range(1, 13))
        assert source.variables['precip'].units == b'mm/day'
        rain = np.asarray(source.variables['precip'][indices], dtype=np.float64)
        assert rain.shape == (12, 72, 144) and np.all(np.isfinite(rain)) and rain.min() >= 0
        annual = np.sum(rain * np.array([calendar.monthrange(2025, dates[i].month)[1] for i in indices])[:, None, None], axis=0)
        lat = source.variables['lat'][:].copy()
        lon = (source.variables['lon'][:].copy() + 180) % 360 - 180
    order = np.argsort(lon)
    annual = annual[:, order]
    area = cell_area(lat - 1.25, lat + 1.25, 2.5)[:, None]
    assert np.isclose(float(area.sum() * 144), 4 * math.pi * RADIUS ** 2, rtol=1e-12)
    volume = annual * area / 1000
    total = float(volume.sum())
    assert 3e14 < total < 7e14
    save_metric('rainfall', 'world', np.linspace(-180, 180, 145), volume.sum(0), np.linspace(-90, 90, 73), volume.sum(1),
                {'name': '年間に降る水の総量', 'dataset': 'GPCP v2.3 (interim)', 'year': 2025, 'resolution': '2.5°',
                 'provider': 'GPCP / NOAA Physical Sciences Laboratory', 'license': 'NOAA public data; attribution requested', 'unit': 'm³/年',
                 'url': 'https://www.ncei.noaa.gov/products/global-precipitation-climatology-project', 'sha256': file_hash(RAW / 'rainfall_2025.nc'),
                 'method': '月平均降水深mm/day×各月の暦日数×球面セル面積÷1000。全球12か月を全量合計。',
                 'note': '海洋と極域を含む全球。雪などの水当量を含みます。2025年は暫定データ。2.5°より細かな分布は不明です。'},
                {'months': 12, 'source_volume': total, 'mean_annual_mm': total / (4 * math.pi * RADIUS ** 2) * 1000,
                 'west_zero_ratio': float(volume[:, :72].sum() / total), 'south_zero_ratio': float(volume[:36].sum() / total)})
    path = RAW / 'rainfall_japan.tif'
    with rasterio.open(path) as source:
        window = from_bounds(*JAPAN.bounds, source.transform).round_offsets().round_lengths()
        window = Window(window.col_off - 1, window.row_off - 1, window.width + 2, window.height + 2)
        rain = source.read(1, window=window)
        transform = source.window_transform(window)
    rows, cols = rain.shape
    x = transform.c + np.arange(cols + 1) * transform.a
    y = transform.f + np.arange(rows + 1) * transform.e
    areas = np.zeros(rain.shape)
    def row_area(row):
        clip = JAPAN.intersection(box(x[0], y[row + 1], x[-1], y[row]))
        values = np.zeros(cols)
        if not clip.is_empty:
            cells = shapely.box(x[:-1], y[row + 1], x[1:], y[row])
            shapely.prepare(clip)
            selected = shapely.intersects(clip, cells)
            values[selected] = polygon_area(shapely.intersection(cells[selected], clip))
        return row, values
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        for row, values in pool.map(row_area, range(rows)):
            areas[row] = values
    valid = np.isfinite(rain) & (rain >= 0)
    missing_area = float(areas[~valid].sum())
    volume = np.where(valid, rain, 0) * areas / 1000
    coverage = 1 - missing_area / areas.sum()
    assert coverage > .98 and 2e11 < volume.sum() < 1.5e12
    save_metric('rainfall', 'japan', x, volume.sum(0), y[::-1], volume.sum(1)[::-1],
                {'name': '年間に降る水の総量', 'dataset': 'CHIRPS v3 annual', 'year': 2025, 'resolution': '0.05° (~5 km)',
                 'provider': 'UCSB Climate Hazards Center', 'license': 'CC BY 4.0 / public-domain statement', 'unit': 'm³/年',
                 'url': 'https://chc.ucsb.edu/data/chirps3', 'sha256': file_hash(path),
                 'method': '年間降水深mm×国土数値情報由来の日本境界と各セルの交差面積÷1000。面積は球面等積変換で計算。欠損セルは補完しない。',
                 'note': f'陸域のみ。境界内の有効面積率 {coverage * 100:.3f}%。海岸や小島で元データが欠損する部分は除外。境界2022年。'},
                {'valid_area_fraction': coverage, 'missing_area_km2': missing_area / 1e6, 'boundary_area_km2': float(areas.sum() / 1e6), 'source_volume': float(volume.sum())})

def cover_tile(item):
    path = RAW / item['file']
    with rasterio.open(path) as source:
        bounds, transform = source.bounds, source.transform
        clip = JAPAN.intersection(box(*bounds))
        window = from_bounds(*clip.bounds, transform).round_offsets().round_lengths()
        window = window.intersection(Window(0, 0, source.width, source.height))
        width, height = source.width, source.height
        results = {key: [np.zeros(width), np.zeros(height)] for key in COVER}
        valid_area, missing_area = 0., 0.
        for row in range(int(window.row_off), int(window.row_off + window.height), 256):
            count = min(256, int(window.row_off + window.height) - row)
            block = Window(window.col_off, row, window.width, count)
            local = box(*rasterio.windows.bounds(block, transform)).intersection(clip)
            if local.is_empty:
                continue
            data = source.read(1, window=block)
            mask = geometry_mask([mapping(local)], out_shape=data.shape, transform=source.window_transform(block), invert=True)
            north = transform.f + (row + np.arange(count)) * transform.e
            area = cell_area(north + transform.e, north, transform.a)
            valid_area += float(np.sum(np.count_nonzero(mask & (data != 0), axis=1) * area))
            missing_area += float(np.sum(np.count_nonzero(mask & (data == 0), axis=1) * area))
            for key, (code, _) in COVER.items():
                selected = mask & (data == code)
                results[key][0][int(window.col_off):int(window.col_off + window.width)] += np.einsum('ij,i->j', selected, area, optimize=False)
                results[key][1][row:row + count] += np.count_nonzero(selected, axis=1) * area
    print('Aggregated', item['file'], flush=True)
    return bounds, transform, results, valid_area, missing_area, file_hash(path)

def make_cover():
    manifest = json.loads((RAW / 'cover_manifest.json').read_text())
    downloaded = [item for item in manifest if item['status'] == 'downloaded']
    missing = [item for item in manifest if item['status'] != 'downloaded']
    step = 1 / 12000
    west, east, south, north = 120, 156, 24, 48
    nx, ny = round((east - west) / step), round((north - south) / step)
    results = {key: [np.zeros(nx), np.zeros(ny)] for key in COVER}
    covered_area, nodata_area, hashes = 0., 0., {}
    with rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024):
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            for item, result in zip(downloaded, pool.map(cover_tile, downloaded)):
                bounds, transform, local, area, missing_area, digest = result
                assert math.isclose(transform.a, step, rel_tol=1e-6)
                xoff, yoff = round((bounds.left - west) / step), round((bounds.bottom - south) / step)
                for key in results:
                    lon, lat = local[key]
                    results[key][0][xoff:xoff + len(lon)] += lon
                    results[key][1][yoff:yoff + len(lat)] += lat[::-1]
                covered_area += area
                nodata_area += missing_area
                hashes[item['file']] = digest
    boundary_area = float(polygon_area(JAPAN))
    coverage = covered_area / boundary_area
    assert .98 < coverage < 1.01
    for key in results:
        lon, lat = results[key]
        assert 0 < lon.sum() <= covered_area
        code, name = COVER[key]
        notes = {'bare': '土・砂・岩などの裸地および植生の非常に少ない土地。砂浜や山岳の岩場等を含みます。', 'shrubland': '低木が優占する土地被覆。', 'wetland': '草本の湿地。マングローブなど別分類の湿地は含みません。', 'forest': '法令上の森林面積とは異なります。', 'cropland': '土地被覆分類による農地です。', 'builtup': '建物などの人工被覆。行政上の市街地・都市区域とは異なります。', 'grassland': '自然草地・牧草地などの草本被覆。農地分類とは別です。', 'water': '年の大半を水が覆う湖・貯水池・河川など。日本境界内のみで海洋は対象外。'}
        metadata = {'name': name, 'dataset': 'ESA WorldCover 2021 v200', 'year': 2021,
                    'resolution': '10 m (1/12000°)', 'provider': 'ESA WorldCover consortium', 'license': 'CC BY 4.0', 'unit': 'm²',
                    'url': 'https://esa-worldcover.org/en/data-access',
                    'method': f'元解像度の全セルからclass {code}を抽出。日本境界内のセル中心を採用し、各緯度の球面実面積で重み付け。',
                    'note': f'日本境界2022年。有効面積率約{coverage * 100:.2f}%。小笠原等の未配布タイル・NoDataは除外。' + notes[key],
                    'hashes': hashes}
        save_metric(key, 'japan', west + np.arange(nx + 1) * step, lon, south + np.arange(ny + 1) * step, lat, metadata,
                    {'valid_area_fraction': coverage, 'valid_area_km2': covered_area / 1e6, 'nodata_area_km2': nodata_area / 1e6,
                     'missing_tiles': missing, 'downloaded_tiles': len(downloaded), 'source_area': float(lon.sum())})

def make_land():
    path = RAW / 'world.geojson'
    features = json.loads(path.read_text(encoding='utf-8'))['features']
    def project(coords):
        return np.column_stack((np.deg2rad(coords[:, 0]) * RADIUS, np.sin(np.deg2rad(coords[:, 1])) * RADIUS))
    land = shapely.union_all([shapely.make_valid(shapely.transform(shape(f['geometry']), project)) for f in features])
    x, y = np.linspace(-180, 180, 7201), np.linspace(-90, 90, 3601)
    px, py = np.deg2rad(x) * RADIUS, np.sin(np.deg2rad(y)) * RADIUS
    def strip_area(item):
        axis, start, stop = item
        cells = shapely.box(px[start:stop], -RADIUS, px[start+1:stop+1], RADIUS) if axis == 0 else shapely.box(-math.pi*RADIUS, py[start:stop], math.pi*RADIUS, py[start+1:stop+1])
        return axis, start, shapely.area(shapely.intersection(land, cells))
    weights = [np.zeros(7200), np.zeros(3600)]
    chunks = [(axis, start, min(start+120, len(values))) for axis, values in enumerate(weights) for start in range(0, len(values), 120)]
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        for axis, start, values in pool.map(strip_area, chunks):
            weights[axis][start:start+len(values)] = values
    total = float(land.area)
    assert 1.3e14 < total < 1.6e14
    assert all(math.isclose(float(w.sum()), total, rel_tol=1e-10) for w in weights)
    cuts = []
    for lon in [-120, -60, 0, 60, 120]:
        direct = land.intersection(box(-math.pi*RADIUS, -RADIUS, math.radians(lon)*RADIUS, RADIUS)).area
        cumulative = float(weights[0][:round((lon+180)/.05)].sum())
        assert math.isclose(direct, cumulative, rel_tol=1e-10)
        cuts.append({'longitude': lon, 'direct_area': direct, 'cdf_area': cumulative})
    save_metric('land', 'world', x, weights[0], y, weights[1],
                {'name': '陸地面積', 'dataset': 'Natural Earth 1:50m country polygons', 'year': '2026年取得',
                 'resolution': '1:50,000,000 / 集計帯0.05°', 'provider': 'Natural Earth', 'license': 'Public domain', 'unit': 'm²',
                 'url': 'https://www.naturalearthdata.com/', 'sha256': file_hash(path),
                 'method': '元の国別ポリゴンを球面等積座標へ変換し、重複を統合。経度・緯度0.05°帯との交差面積を集計。',
                 'note': '南極を含む。簡略化された海岸線・国別ポリゴンに基づく面積。湖などは原図の穴の表現に従い、厳密な陸水分離ではありません。'},
                {'source_area': total, 'cuts': cuts, 'includes_antarctica': True})

def make_seasons(periods):
    path = RAW / 'rainfall_2025.nc'
    base = json.loads((OUT / 'rainfall_world.json').read_text(encoding='utf-8'))
    with netcdf_file(path, mmap=False) as source:
        dates = [dt.datetime(1800, 1, 1) + dt.timedelta(days=float(day)) for day in source.variables['time'][:]]
        lat = source.variables['lat'][:].copy()
        order = np.argsort((source.variables['lon'][:].copy() + 180) % 360 - 180)
        for key, months, label in periods:
            indices = [i for i, date in enumerate(dates) if date.year == 2025 and date.month in months]
            assert sorted(dates[i].month for i in indices) == sorted(months)
            rain = np.asarray(source.variables['precip'][indices], dtype=np.float64)
            assert np.all(np.isfinite(rain)) and rain.min() >= 0
            days = np.array([calendar.monthrange(2025, dates[i].month)[1] for i in indices])
            depth = np.sum(rain * days[:, None, None], axis=0)[:, order]
            volume = depth * cell_area(lat-1.25, lat+1.25, 2.5)[:, None] / 1000
            assert 0 < volume.sum() < base['total']
            metadata = dict(base['metadata'], name=label+'に降る水の総量', unit='m³/対象期間',
                            method='2025年の対象月の平均降水深mm/day×暦日数×球面セル面積÷1000。',
                            note='対象月：'+label+'（すべて2025年）。海洋・極域と雪の水当量を含む暫定値。')
            save_metric(key, 'world', np.linspace(-180,180,145), volume.sum(0), np.linspace(-90,90,73), volume.sum(1), metadata,
                        {'months': months, 'year': 2025, 'source_volume': float(volume.sum()), 'days': int(days.sum())})

def make_ocean():
    land = json.loads((OUT / 'land_world.json').read_text(encoding='utf-8'))
    axes, weights = [], []
    for key in ['longitude', 'latitude']:
        axis = land[key]
        edges = np.asarray(axis['edges'])
        full = cell_area(-90, 90, np.diff(edges)) if key == 'longitude' else cell_area(edges[:-1], edges[1:], 360)
        water = full - np.asarray(axis['distribution'])
        assert water.min() > -1
        axes.append(edges)
        weights.append(np.maximum(water, 0))
    assert math.isclose(weights[0].sum() + land['total'], 4 * math.pi * RADIUS ** 2, rel_tol=1e-10)
    metadata = dict(land['metadata'], name='海洋面積（原図の水域）',
                    method='球面全体の各帯の面積から、Natural Earthの陸地ポリゴン面積を差し引く。',
                    note='海洋を中心とした原図の水域。原図で陸地から除外された湖なども含み、厳密な海洋のみの面積ではありません。')
    save_metric('ocean', 'world', axes[0], weights[0], axes[1], weights[1], metadata,
                {'sphere_area': 4 * math.pi * RADIUS ** 2, 'land_area': land['total'], 'includes_inland_water': True})

def make_built():
    archive = RAW / 'built_world.zip'
    with zipfile.ZipFile(archive) as package:
        names = [name for name in package.namelist() if name.lower().endswith('.tif')]
        assert len(names) == 1
        path = RAW / 'built_world.tif'
        if not path.exists():
            temporary = path.with_suffix('.tif.part')
            with package.open(names[0]) as source, temporary.open('wb') as output:
                shutil.copyfileobj(source, output, 1024*1024)
            assert temporary.stat().st_size == package.getinfo(names[0]).file_size
            temporary.replace(path)
    with rasterio.open(path) as source:
        width, height, transform = source.width, source.height, source.transform
        assert source.crs.to_epsg() == 4326 and transform.a > 0 and transform.e < 0
        print('Built surface raster', width, height, source.dtypes, source.nodata, flush=True)
    cols = [max(0, min(width, round((lon-transform.c)/transform.a))) for lon in [-90,0,90]]
    def aggregate(row):
        count = min(128, height-row)
        with rasterio.open(path) as source:
            values = source.read(1, window=Window(0,row,width,count), masked=True).filled(0).astype(np.float64)
        values[~np.isfinite(values) | (values < 0)] = 0
        return row, values.sum(0), values.sum(1), values.sum(), [values[:,:col].sum() for col in cols]
    lon, lat, direct = np.zeros(width), np.zeros(height), np.zeros(len(cols))
    total = 0.
    with rasterio.Env(GDAL_CACHEMAX=64*1024*1024):
        with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
            for row, x, y, area, checks in pool.map(aggregate, range(0,height,128)):
                lon += x; lat[row:row+len(y)] = y; total += area; direct += checks
    assert 0 < total < 1.5e14 and math.isclose(total, lon.sum(), rel_tol=1e-12)
    cumulative = np.r_[0.,np.cumsum(lon)]
    assert np.allclose(cumulative[cols], direct, rtol=1e-10, atol=1)
    edges = transform.c+np.arange(width+1)*transform.a
    canonical = np.linspace(-180, 180, 43201)
    wrapped = sum(np.interp(canonical+offset, edges, cumulative) for offset in [-360, 0, 360])
    adjusted = np.diff(wrapped)
    assert adjusted.min() >= 0 and math.isclose(adjusted.sum(), total, rel_tol=1e-12)
    save_metric('building', 'world', canonical, adjusted,
                (transform.f+np.arange(height+1)*transform.e)[::-1], lat[::-1],
                {'name': '建物が覆う面積', 'dataset': 'GHS-BUILT-S R2023A', 'year': 2020,
                 'resolution': '30 arc-seconds (~1 km)', 'provider': 'European Commission Joint Research Centre / Pesaresi & Politis (2023)',
                 'license': 'CC BY 4.0', 'unit': 'm²', 'url': 'https://human-settlement.emergency.copernicus.eu/ghs_buS2023.php',
                 'sha256': file_hash(archive), 'method': '2020年の各セルのbuilt-up surface（m²）を全量合計。NoDataを除外し面積を再乗算しない。元の経度格子の微小なずれを帯内一様の面積配分で正規30秒帯へ保存的に移し、日付変更線の外側は反対側へ折り返す。',
                 'note': '衛星観測と時間補間に基づく2020年推計。建物の地表被覆面積で、延べ床面積や行政上の市街地面積ではありません。'},
                {'source_grid_total': float(total), 'wrapped_total': float(adjusted.sum()), 'source_width': width, 'source_height': height,
                 'cuts': [{'longitude': float(transform.c+col*transform.a), 'raw_west_total': float(value), 'cdf_west_total': float(cumulative[col])} for col,value in zip(cols,direct)]})

def make_bundle():
    datasets = [json.loads(path.read_text(encoding='utf-8')) for path in sorted(OUT.glob('*.json')) if path.stem.startswith(tuple(key + '_' for key in [*COVER, 'population', 'rainfall', 'land', 'ocean', 'rainperiod', 'building']))]
    for data in datasets:
        for name in ['longitude', 'latitude']:
            axis = data[name]
            edges, weights = np.asarray(axis['edges']), np.asarray(axis['distribution'])
            nonzero = np.flatnonzero(weights)
            first, last = max(0, int(nonzero[0]) - 1), min(len(weights), int(nonzero[-1]) + 2)
            decimals = 6 if data['metric'] == 'population' else 3
            packed = np.round(weights[first:last], decimals)
            error = np.max(np.abs(np.cumsum(packed) - np.cumsum(weights[first:last]))) / data['total']
            assert error < 1e-7
            data[name] = {'origin': float(edges[first]), 'step': float(edges[1] - edges[0]),
                          'distribution': packed.tolist(), 'median': axis['median']}
            data['validation'][name + '_packing_relative_error'] = float(error)
    bundle = {'datasets': datasets, 'maps': {key: json.loads((OUT / f'{key}.geojson').read_text(encoding='utf-8')) for key in ['world', 'japan']}}
    unpack = '\nfor(const d of window.GAME_DATA.datasets){for(const k of ["longitude","latitude"]){const a=d[k];a.edges=Array.from({length:a.distribution.length+1},(_,i)=>a.origin+i*a.step);a.cumulative=[0];for(const w of a.distribution)a.cumulative.push(a.cumulative[a.cumulative.length-1]+w);}}\n'
    (OUT / 'bundle.js').write_text('window.GAME_DATA=' + json.dumps(bundle, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + ';' + unpack, encoding='utf-8')
    report = {data['id']: {'total': data['total'], 'longitude_median': data['longitude']['median'], 'latitude_median': data['latitude']['median'], 'validation': data['validation']} for data in datasets}
    write_json(ROOT / 'validation.json', report)
    print('BUNDLE', len(datasets), 'datasets', (OUT / 'bundle.js').stat().st_size, 'bytes', flush=True)

if args.stage in ['maps', 'all']:
    make_maps()
if args.stage in ['rain', 'all']:
    make_rain()
if args.stage in ['cover', 'all']:
    make_cover()
if args.stage in ['land', 'all']:
    make_land()
if args.stage in ['ocean', 'all']:
    make_ocean()
if args.stage in ['seasons', 'all']:
    periods = []
    for length in [1, 3, 6]:
        for start in range(1, 13, length):
            months = list(range(start, start + length))
            label = f'{start}月' if length == 1 else f'{start}〜{months[-1]}月'
            periods.append((f'rainperiod_{length:02}_{start:02}', months, label))
    make_seasons(periods)
if args.stage in ['population', 'all']:
    for region in (['world', 'japan'] if args.region == 'all' else [args.region]):
        make_population(region)
if args.stage in ['built', 'all']:
    make_built()
if args.stage in ['bundle', 'all']:
    make_bundle()


