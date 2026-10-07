import argparse
import concurrent.futures
import json
from pathlib import Path
import sys
import urllib.request

parser = argparse.ArgumentParser(description='Download the original public grids used by 50:50.')
parser.add_argument('--raw', type=Path, required=True)
parser.add_argument('--deps', type=Path)
args = parser.parse_args()
if args.deps:
    sys.path.insert(0, str(args.deps.resolve()))
import shapely
from shapely.geometry import shape, box

args.raw.mkdir(parents=True, exist_ok=True)
worldpop = 'https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2025/'
sources = {
    'built_world.zip': 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/GHS_BUILT_S_E2020_GLOBE_R2023A_4326_30ss/V1-0/GHS_BUILT_S_E2020_GLOBE_R2023A_4326_30ss_V1_0.zip',
    'population_world.tif': worldpop + '0_Mosaicked/v1/1km/constrained/global_pop_2025_CN_1km_R2025A_v1.tif',
    'population_japan.tif': worldpop + 'JPN/v1/100m/constrained/jpn_pop_2025_CN_100m_R2025A_v1.tif',
    'rainfall_japan.tif': 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/annual/global/tifs/chirps-v3.0.2025.tif',
    'rainfall_2025.nc': 'https://psl.noaa.gov/thredds/ncss/grid/Datasets/gpcp/precip.mon.mean.nc?var=precip&north=90&south=-90&west=0&east=360&horizStride=1&time_start=2025-01-01T00%3A00%3A00Z&time_end=2025-12-31T23%3A59%3A59Z&accept=netcdf3',
    'world.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
    'japan_metadata.json': 'https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM0/',
    'japan.geojson': 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/JPN/ADM0/geoBoundaries-JPN-ADM0.geojson',
}

def download(item):
    name, url = item
    path = args.raw / name
    if path.exists():
        print('EXISTS', name, flush=True)
        return
    temporary = path.with_suffix(path.suffix + '.part')
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
        print('DOWNLOAD', name, flush=True)
        received = 0
        while chunk := response.read(65536):
            output.write(chunk)
            received += len(chunk)
    if not received:
        raise ValueError('Empty response: ' + url)
    temporary.replace(path)
    print('COMPLETE', name, received, flush=True)

with concurrent.futures.ThreadPoolExecutor(4) as pool:
    list(pool.map(download, sources.items()))
japan = shapely.union_all([shape(f['geometry']) for f in json.loads((args.raw / 'japan.geojson').read_text(encoding='utf-8'))['features']])
tiles = []
for lat in range(24, 48, 3):
    for lon in range(120, 156, 3):
        if japan.intersects(box(lon, lat, lon + 3, lat + 3)):
            key = f'N{lat:02}E{lon:03}'
            tiles.append((f'cover_{key}.tif', f'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{key}_Map.tif'))

def download_tile(item):
    try:
        download(item)
        return {'file': item[0], 'url': item[1], 'status': 'downloaded'}
    except Exception as error:
        print('UNAVAILABLE', item[0], str(error), flush=True)
        return {'file': item[0], 'url': item[1], 'status': str(error)}

with concurrent.futures.ThreadPoolExecutor(4) as pool:
    manifest = list(pool.map(download_tile, tiles))
(args.raw / 'cover_manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(args.raw / 'download_sources.json').write_text(json.dumps(sources, indent=2), encoding='utf-8')

