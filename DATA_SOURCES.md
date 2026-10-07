# 50:50 収録データ

2026-10-07 集計・検証完了。33データセットを収録。詳細な結果は validation.json と README.md を参照。

世界人口はWorldPopを採用。JRC GHS-WUP-POPも予備として取得したが、ゲームには使用していない。

|用途|データセット・提供元・URL|年|解像度|利用条件|対象|集計方法|
|---|---|---|---|---|---|---|
|人口|[WorldPop Global2 R2025A v1](https://hub.worldpop.org/project/categories?id=3)|2025|世界30秒（約1 km）、日本3秒（約100 m）|CC BY 4.0。モデルによる推計人口|世界・日本|公式全球モザイクと日本専用グリッドの全有効セルを元解像度で行・列に合計。日本専用ファイルは提供元の国別マスクを保持|
|年間降水体積|[CHIRPS v3 / UCSB Climate Hazards Center](https://chc.ucsb.edu/data/chirps3)|2025|0.05°|公式ページ記載CC BY 4.0 / public domain、出典表示|日本のみ|年間降水深mm×日本境界内セル面積。極域を欠くため世界問題には流用しない|
|年間降水体積|[GPCP v2.3 / NOAA PSL](https://www.ncei.noaa.gov/products/global-precipitation-climatology-project)|2025（暫定値）|2.5°|NOAA公開データ、提供元・論文を表示|世界（海洋を含む）|月平均mm/day×暦月日数×球面セル面積を全球・12か月合計|
|樹木被覆・農地・市街地・草地・水面|[ESA WorldCover v200](https://esa-worldcover.org/en/data-access)|2021|10 m|CC BY 4.0|日本（29タイル、有効面積約99.97%）|元セルのTree cover(10)・Cropland(40)・Built-up(50)・Grassland(30)・Permanent water(80)×緯度別セル面積。日本境界でマスク。全球約117 GBの一括取得は今回実施しない|
|世界表示地図|[Natural Earth](https://www.naturalearthdata.com/)|2026-10-06取得|縮尺1:50,000,000|Public domain|世界|実境界GeoJSONを描画。陸地面積のみ元形状の球面等積面積を0.05°帯で集計。人口などの統計値は地図形状から生成しない|
|日本境界・地図|[geoBoundaries gbOpen JPN ADM0](https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM0/)|2022|行政境界ベクトル。統計解像度とは異なる|CC BY 4.0（国土数値情報）|日本|解析に原形状、表示は必要に応じて位相保持簡略化|

## 今回の注意点

- 「最高精度」を保証するものではない。元データの解像度と推計・観測誤差を明記し、間引きサンプリングで分布を作らない。
- EDGAR 2025の化石CO2はIEA由来CC BY-NC-ND 4.0の条件があるため、後のWeb配布も想定し今回は収録しない。[提供元の条件](https://edgar.jrc.ec.europa.eu/dataset_ghg2025)
- 夜間光は未取得。偽データを入れない。
- 累積分布はセル境界に保存し、セル内は一様と仮定して線形補間する。細かい回答操作が観測解像度の向上を意味するわけではない。
- 最大4並列。読み込みを小ブロックに分け、巨大配列を一括展開しない。配布先には軽量集計結果のみを入れる。


世界の陸地面積は南極を含み、陸水境界は原図に従う。総面積と5か所の直接切断面積を累積分布と照合。

追加：ESA WorldCover class 20低木地・90草本湿地。GPCP 2025年の月別12・四半期別4・半期別2・年間1の計19期間。海洋はNatural Earth陸地の補集合で湖等も含む。各指標の出典・処理・検証はbundleとvalidation.jsonに収録。


世界建物被覆：GHS-BUILT-S R2023A、2020年、30秒、JRC、CC BY 4.0。各セルのbuilt-up surface（m²）を全量合計。日本裸地・岩場：ESA WorldCover 2021 class 60、既存日本マスクと球面セル面積で集計。
