import pandas as pd

df = pd.read_csv('data/requests.csv')
print('=== image_resize stats ===')
img = df[df['type']=='image_resize']
print(f'Count: {len(img)}')
print(f'wallMs: min={img["actualWallMs"].min():.1f}, max={img["actualWallMs"].max():.1f}, mean={img["actualWallMs"].mean():.1f}')
print(f'cpuMs: min={img["actualCpuMs"].min():.1f}, max={img["actualCpuMs"].max():.1f}, mean={img["actualCpuMs"].mean():.1f}')
print(f'ioMs: min={img["ioMs"].min():.1f}, max={img["ioMs"].max():.1f}, mean={img["ioMs"].mean():.1f}')
print(f'wallMs - ioMs (CPU): min={(img["actualWallMs"]-img["ioMs"]).min():.1f}, max={(img["actualWallMs"]-img["ioMs"]).max():.1f}, mean={(img["actualWallMs"]-img["ioMs"]).mean():.1f}')
print()
print('=== report_generate stats ===')
rpt = df[df['type']=='report_generate']
print(f'Count: {len(rpt)}')
print(f'wallMs: min={rpt["actualWallMs"].min():.1f}, max={rpt["actualWallMs"].max():.1f}, mean={rpt["actualWallMs"].mean():.1f}')
print(f'cpuMs: min={rpt["actualCpuMs"].min():.1f}, max={rpt["actualCpuMs"].max():.1f}, mean={rpt["actualCpuMs"].mean():.1f}')
print(f'ioMs: min={rpt["ioMs"].min():.1f}, max={rpt["ioMs"].max():.1f}, mean={rpt["ioMs"].mean():.1f}')
print(f'wallMs - ioMs (CPU): min={(rpt["actualWallMs"]-rpt["ioMs"]).min():.1f}, max={(rpt["actualWallMs"]-rpt["ioMs"]).max():.1f}, mean={(rpt["actualWallMs"]-rpt["ioMs"]).mean():.1f}')